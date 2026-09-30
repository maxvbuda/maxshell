// mx2's hot loops as WebAssembly SIMD, built into src/mx2kernels.wasm by
//   clang --target=wasm32 -O3 -msimd128 -matomics -mbulk-memory -nostdlib -c src/mx2kernels.c -o src/mx2kernels.wasm
// (an object file is a loadable module: it imports its memory and uses no
// globals, so src/mx2.js instantiates it directly on shared memory).
#include <wasm_simd128.h>

typedef signed char i8;

static inline float hsum(v128_t v) {
  return wasm_f32x4_extract_lane(v, 0) + wasm_f32x4_extract_lane(v, 1) + wasm_f32x4_extract_lane(v, 2) + wasm_f32x4_extract_lane(v, 3);
}

// out[t*rows + r] = scale[r] * (W[r] · X[t]) for rows r0..r1 and T tokens.
// W is int8, [rows][cols]; cols is a multiple of 8.
__attribute__((export_name("mm")))
void mm(const i8 *W, const float *S, int r0, int r1, int cols, int T, const float *X, float *out, int rows) {
  for (int r = r0; r < r1; r++) {
    const i8 *w = W + (long)r * cols;
    float sc = S[r];
    int t = 0;
    for (; t + 4 <= T; t += 4) {
      const float *x0 = X + t * cols, *x1 = x0 + cols, *x2 = x1 + cols, *x3 = x2 + cols;
      v128_t a0 = wasm_f32x4_splat(0), a1 = a0, a2 = a0, a3 = a0;
      for (int i = 0; i < cols; i += 8) {
        v128_t b = wasm_i16x8_load8x8(w + i);
        v128_t lo = wasm_f32x4_convert_i32x4(wasm_i32x4_extend_low_i16x8(b));
        v128_t hi = wasm_f32x4_convert_i32x4(wasm_i32x4_extend_high_i16x8(b));
        a0 = wasm_f32x4_add(a0, wasm_f32x4_add(wasm_f32x4_mul(lo, wasm_v128_load(x0 + i)), wasm_f32x4_mul(hi, wasm_v128_load(x0 + i + 4))));
        a1 = wasm_f32x4_add(a1, wasm_f32x4_add(wasm_f32x4_mul(lo, wasm_v128_load(x1 + i)), wasm_f32x4_mul(hi, wasm_v128_load(x1 + i + 4))));
        a2 = wasm_f32x4_add(a2, wasm_f32x4_add(wasm_f32x4_mul(lo, wasm_v128_load(x2 + i)), wasm_f32x4_mul(hi, wasm_v128_load(x2 + i + 4))));
        a3 = wasm_f32x4_add(a3, wasm_f32x4_add(wasm_f32x4_mul(lo, wasm_v128_load(x3 + i)), wasm_f32x4_mul(hi, wasm_v128_load(x3 + i + 4))));
      }
      out[t * rows + r] = hsum(a0) * sc;
      out[(t + 1) * rows + r] = hsum(a1) * sc;
      out[(t + 2) * rows + r] = hsum(a2) * sc;
      out[(t + 3) * rows + r] = hsum(a3) * sc;
    }
    for (; t < T; t++) {
      const float *x = X + t * cols;
      v128_t a = wasm_f32x4_splat(0), c = a;
      for (int i = 0; i < cols; i += 8) {
        v128_t b = wasm_i16x8_load8x8(w + i);
        a = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_f32x4_convert_i32x4(wasm_i32x4_extend_low_i16x8(b)), wasm_v128_load(x + i)));
        c = wasm_f32x4_add(c, wasm_f32x4_mul(wasm_f32x4_convert_i32x4(wasm_i32x4_extend_high_i16x8(b)), wasm_v128_load(x + i + 4)));
      }
      out[t * rows + r] = hsum(wasm_f32x4_add(a, c)) * sc;
    }
  }
}

// out[s] = scale * (q · K[s]) for s < n; K rows are `stride` floats apart.
__attribute__((export_name("scores")))
void scores(const float *q, const float *K, int n, int stride, int hd, float scale, float *out) {
  for (int s = 0; s < n; s++) {
    const float *k = K + (long)s * stride;
    v128_t a = wasm_f32x4_splat(0);
    for (int i = 0; i < hd; i += 4) a = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_v128_load(q + i), wasm_v128_load(k + i)));
    out[s] = hsum(a) * scale;
  }
}

// out = Σ p[s] · V[s] over s < n.
__attribute__((export_name("wsum")))
void wsum(const float *p, const float *V, int n, int stride, int hd, float *out) {
  for (int i = 0; i < hd; i += 4) {
    v128_t a = wasm_f32x4_splat(0);
    for (int s = 0; s < n; s++) a = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_f32x4_splat(p[s]), wasm_v128_load(V + (long)s * stride + i)));
    wasm_v128_store(out + i, a);
  }
}
