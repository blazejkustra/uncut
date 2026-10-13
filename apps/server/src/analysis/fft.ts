// A small in-place radix-2 complex FFT, shared by the video analyzer's phase correlation (D67) and
// the beats analyzer's spectrogram (D70). No dependency: the sizes are small (64–1024 points).

/** cos/sin of 2πk/n for k < n/2: the twiddle factors for an n-point FFT. */
export function fftTables(n: number): readonly [Float64Array, Float64Array] {
  const c = new Float64Array(n / 2);
  const s = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    c[k] = Math.cos((2 * Math.PI * k) / n);
    s[k] = Math.sin((2 * Math.PI * k) / n);
  }
  return [c, s];
}

/** In-place radix-2 complex FFT of length n (a power of two) over re/im at offset, stride. */
export function fft(re: Float64Array, im: Float64Array, offset: number, stride: number, n: number, inverse: boolean, cos: Float64Array, sin: Float64Array) {
  // Bit reversal.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride;
      const b = offset + j * stride;
      let t = re[a]!;
      re[a] = re[b]!;
      re[b] = t;
      t = im[a]!;
      im[a] = im[b]!;
      im[b] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = inverse ? sin[k * step]! : -sin[k * step]!;
        const a = offset + (i + k) * stride;
        const b = offset + (i + k + half) * stride;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}
