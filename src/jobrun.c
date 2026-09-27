/*
 * jobrun — the part of maxshell's job control that Node can't do itself.
 *
 *   jobrun STATUSFILE fg|bg PROGRAM [ARGS...]
 *
 * Runs PROGRAM in a process group of its own. In the foreground it hands the
 * program the terminal, so Ctrl-C and Ctrl-Z reach the program and not the
 * shell. It reports what happens by rewriting STATUSFILE with one line:
 *
 *   running        started, or resumed in the background
 *   stopped SIG    suspended (Ctrl-Z, or a background read from the tty)
 *   exit N         finished with status N
 *   signal SIG     killed by signal SIG
 *
 * The shell steers a job by signalling this process: SIGUSR1 brings it to
 * the foreground, SIGUSR2 continues it in the background, SIGHUP hangs it up.
 * Terminal modes are saved and restored around the job, as shells do.
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static const char *status_path;
static volatile sig_atomic_t want_fg = 0, want_bg = 0, want_hup = 0;

static void on_signal(int sig) {
  if (sig == SIGUSR1) want_fg = 1;
  else if (sig == SIGUSR2) want_bg = 1;
  else if (sig == SIGHUP) want_hup = 1;
}

static void report(const char *fmt, int n) {
  char tmp[4096], line[64];
  snprintf(tmp, sizeof tmp, "%s.tmp", status_path);
  int len = snprintf(line, sizeof line, fmt, n);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return;
  if (write(fd, line, (size_t)len) < 0) { /* nothing more we can do */ }
  close(fd);
  rename(tmp, status_path);
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: jobrun STATUSFILE fg|bg PROGRAM [ARGS...]\n");
    return 2;
  }
  status_path = argv[1];
  int foreground = strcmp(argv[2], "fg") == 0;

  int tty = isatty(STDIN_FILENO) ? STDIN_FILENO : open("/dev/tty", O_RDWR);
  pid_t shell_pgrp = getpgrp();
  struct termios shell_modes, job_modes;
  int have_modes = tty >= 0 && tcgetattr(tty, &shell_modes) == 0;
  int have_job_modes = 0;

  // The helper itself must survive the keys meant for the job.
  signal(SIGINT, SIG_IGN);
  signal(SIGQUIT, SIG_IGN);
  signal(SIGTSTP, SIG_IGN);
  signal(SIGTTIN, SIG_IGN);
  signal(SIGTTOU, SIG_IGN);

  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_signal;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0; /* no SA_RESTART: a signal interrupts waitpid */
  sigaction(SIGUSR1, &sa, NULL);
  sigaction(SIGUSR2, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);

  // The control signals stay blocked except while we wait, so none is lost
  // between checking the flags and going to sleep.
  sigset_t ctl, old;
  sigemptyset(&ctl);
  sigaddset(&ctl, SIGUSR1);
  sigaddset(&ctl, SIGUSR2);
  sigaddset(&ctl, SIGHUP);
  sigprocmask(SIG_BLOCK, &ctl, &old);
  sigset_t open_mask = old;
  sigdelset(&open_mask, SIGUSR1);
  sigdelset(&open_mask, SIGUSR2);
  sigdelset(&open_mask, SIGHUP);

  pid_t child = fork();
  if (child < 0) { report("exit %d\n", 126); return 1; }
  if (child == 0) {
    setpgid(0, 0);
    if (foreground && tty >= 0) tcsetpgrp(tty, getpgrp());
    signal(SIGINT, SIG_DFL);
    signal(SIGQUIT, SIG_DFL);
    signal(SIGTSTP, SIG_DFL);
    signal(SIGTTIN, SIG_DFL);
    signal(SIGTTOU, SIG_DFL);
    signal(SIGUSR1, SIG_DFL);
    signal(SIGUSR2, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    if (tty > 2) close(tty);
    execvp(argv[3], argv + 3);
    fprintf(stderr, "maxshell: %s: %s\n", argv[3], strerror(errno));
    _exit(errno == ENOENT ? 127 : 126);
  }
  setpgid(child, child);
  if (foreground && tty >= 0) tcsetpgrp(tty, child);
  report("running %d\n", child);

  for (;;) {
    int st;
    pid_t r = 0;
    if (!want_fg && !want_bg && !want_hup) {
      sigprocmask(SIG_SETMASK, &open_mask, NULL);
      r = waitpid(child, &st, WUNTRACED | WCONTINUED);
      int saved = errno;
      sigprocmask(SIG_BLOCK, &ctl, NULL);
      errno = saved;
    } else {
      r = -1;
      errno = EINTR;
    }
    if (r < 0) {
      if (errno != EINTR) { report("exit %d\n", 127); return 1; }
      if (want_hup) { want_hup = 0; kill(-child, SIGHUP); kill(-child, SIGCONT); }
      if (want_fg) {
        want_fg = 0;
        foreground = 1;
        if (tty >= 0) {
          if (have_job_modes) tcsetattr(tty, TCSADRAIN, &job_modes);
          tcsetpgrp(tty, child);
        }
        kill(-child, SIGCONT);
        report("running %d\n", child);
      }
      if (want_bg) {
        want_bg = 0;
        foreground = 0;
        kill(-child, SIGCONT);
        report("running %d\n", child);
      }
      continue;
    }
    if (WIFSTOPPED(st)) {
      if (foreground && tty >= 0) {
        have_job_modes = tcgetattr(tty, &job_modes) == 0;
        tcsetpgrp(tty, shell_pgrp);
        if (have_modes) tcsetattr(tty, TCSADRAIN, &shell_modes);
      }
      foreground = 0;
      report("stopped %d\n", WSTOPSIG(st));
      continue;
    }
    // Continued by someone else (kill -CONT): it runs in the background.
    if (WIFCONTINUED(st)) {
      report("running %d\n", child);
      continue;
    }
    if (foreground && tty >= 0) {
      tcsetpgrp(tty, shell_pgrp);
      if (have_modes) tcsetattr(tty, TCSADRAIN, &shell_modes);
    }
    if (WIFSIGNALED(st)) report("signal %d\n", WTERMSIG(st));
    else report("exit %d\n", WEXITSTATUS(st));
    return 0;
  }
}
