#!/usr/bin/env node
// A stand-in for ddgr (MAXSHELL_DDGR) in the tests: ddgr --json --np -n N query
const args = process.argv.slice(2);
const n = Number(args[args.indexOf('-n') + 1]) || 10;
const query = args[args.length - 1];
if (/offline/.test(query)) process.exit(1); // no connection: ddgr prints nothing
if (/nothing/.test(query)) { process.stdout.write('[]\n'); process.exit(0); }
const results = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ title: `${query} — result ${i}`, url: `https://example.com/${i}`, abstract: `What page ${i} says about ${query}.` }));
process.stdout.write(JSON.stringify(results.slice(0, n), null, 2) + '\n');
