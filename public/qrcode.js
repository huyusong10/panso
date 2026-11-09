// 零依赖纯前端 ISO/IEC 18004 QR Code SVG 生成器 (Versions 1..10, ECC Level L, Byte Mode)
(function (global) {
  'use strict';

  // 各版本 (1..10) 在 ECC Level L 下的参数: [totalCodewords, ecCodewordsPerBlock, numBlocks]
  const VERSION_PARAMS = [
    null,
    [26, 7, 1],
    [44, 10, 1],
    [70, 15, 1],
    [100, 20, 1],
    [134, 26, 1],
    [172, 18, 2],
    [196, 20, 2],
    [242, 24, 2],
    [292, 30, 2],
    [346, 18, 4]
  ];

  // 对齐图案中心坐标 (Versions 1..10)
  const ALIGNMENT_POS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50]
  ];

  // GF(256) 指数与对数表 (本原多项式 0x11d)
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      EXP[i] = EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      const next = new Uint8Array(poly.length + 1);
      const root = EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], root);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const rem = new Uint8Array(ecLen);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecLen - 1] = 0;
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return rem;
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  function pickVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      const [total, ecPerBlock, blocks] = VERSION_PARAMS[v];
      const dataCap = total - ecPerBlock * blocks;
      const headerBits = v <= 9 ? 4 + 8 : 4 + 16;
      if (byteLen * 8 + headerBits <= dataCap * 8) return v;
    }
    return 10;
  }

  function buildCodewords(bytes, version) {
    const [totalCodewords, ecPerBlock, numBlocks] = VERSION_PARAMS[version];
    const totalDataCodewords = totalCodewords - ecPerBlock * numBlocks;

    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };

    // Byte mode indicator (0100)
    pushBits(0b0100, 4);
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) pushBits(b, 8);

    const maxBits = totalDataCodewords * 8;
    const term = Math.min(4, maxBits - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataWords = new Uint8Array(totalDataCodewords);
    const byteCount = bits.length >>> 3;
    for (let i = 0; i < byteCount; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
      dataWords[i] = b;
    }
    const pads = [0xec, 0x11];
    for (let i = byteCount; i < totalDataCodewords; i++) {
      dataWords[i] = pads[(i - byteCount) & 1];
    }

    // 分块并交织
    const shortBlockLen = Math.floor(totalDataCodewords / numBlocks);
    const numLongBlocks = totalDataCodewords % numBlocks;
    const numShortBlocks = numBlocks - numLongBlocks;

    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let i = 0; i < numBlocks; i++) {
      const len = shortBlockLen + (i >= numShortBlocks ? 1 : 0);
      const blk = dataWords.subarray(offset, offset + len);
      offset += len;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecPerBlock));
    }

    const result = [];
    const maxDataLen = shortBlockLen + (numLongBlocks > 0 ? 1 : 0);
    for (let i = 0; i < maxDataLen; i++) {
      for (let b = 0; b < numBlocks; b++) {
        if (i < dataBlocks[b].length) result.push(dataBlocks[b][i]);
      }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (let b = 0; b < numBlocks; b++) {
        result.push(ecBlocks[b][i]);
      }
    }
    return result;
  }

  function createMatrix(version, codewords) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    const setFunc = (r, c, val) => {
      modules[r][c] = val ? 1 : 0;
      isFunc[r][c] = 1;
    };

    const drawFinder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const on =
            (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
            (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          setFunc(r, c, on);
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    // Alignment patterns
    const pos = ALIGNMENT_POS[version];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === pos.length - 1) ||
          (i === pos.length - 1 && j === 0)
        ) {
          continue;
        }
        const cr = pos[i];
        const cc = pos[j];
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunc(cr + dr, cc + dc, on);
          }
        }
      }
    }

    // Reserve format info areas & dark module
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        isFunc[8][i] = 1;
        isFunc[i][8] = 1;
      }
    }
    for (let i = 0; i < 8; i++) {
      isFunc[8][size - 1 - i] = 1;
      isFunc[size - 1 - i][8] = 1;
    }
    setFunc(size - 8, 8, true);

    // Version info for v >= 7
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const vBits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (vBits >>> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunc(a, b, bit);
        setFunc(b, a, bit);
      }
    }

    // Place data bits (zigzag)
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (!isFunc[r][c] && bitIdx < totalBits) {
            const bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
            modules[r][c] = bit;
            bitIdx++;
          }
        }
      }
    }

    // Apply Mask 0: (r + c) % 2 === 0
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunc[r][c] && (r + c) % 2 === 0) {
          modules[r][c] ^= 1;
        }
      }
    }

    // Format bits for ECC Level L (01) and Mask 0 (000)
    const data = (0b01 << 3) | 0;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const formatBits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) setFunc(8, i, (formatBits >>> i) & 1);
    setFunc(8, 7, (formatBits >>> 6) & 1);
    setFunc(8, 8, (formatBits >>> 7) & 1);
    setFunc(7, 8, (formatBits >>> 8) & 1);
    for (let i = 9; i < 15; i++) setFunc(14 - i, 8, (formatBits >>> i) & 1);

    for (let i = 0; i < 8; i++) setFunc(size - 1 - i, 8, (formatBits >>> i) & 1);
    for (let i = 8; i < 15; i++) setFunc(8, size - 15 + i, (formatBits >>> i) & 1);

    return modules;
  }

  function renderQrSvg(text, sizePx = 156) {
    let bytes = utf8Bytes(String(text || ''));
    if (bytes.length > 260) {
      bytes = bytes.slice(0, 260);
    }
    const version = pickVersion(bytes.length);
    const codewords = buildCodewords(bytes, version);
    const matrix = createMatrix(version, codewords);
    const n = matrix.length;
    const quiet = 2;
    const total = n + quiet * 2;

    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          path += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" rx="1.5" fill="#FCFBF8"/><path d="${path}" fill="#214E3F"/></svg>`;
  }

  global.renderPanSongQrSvg = renderQrSvg;
})(typeof window !== 'undefined' ? window : globalThis);
