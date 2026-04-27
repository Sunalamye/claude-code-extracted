#!/usr/bin/env node
// Strip the `(function(exports, require, module, __filename, __dirname){ ... })`
// IIFE wrapper that bun's compile step adds to CJS modules, and prepend a
// shebang so the file becomes directly executable under Node.
//
// Usage: unwrap-cjs.cjs <input.js> <output.js>

'use strict';

const fs = require('fs');

function unwrap(buf) {
  const open = buf.indexOf(0x7b /* '{' */);
  const close = buf.lastIndexOf(Buffer.from('})'));
  if (open < 0 || close < 0 || close <= open) {
    throw new Error('IIFE wrapper not found — input may already be unwrapped');
  }
  return Buffer.concat([
    Buffer.from('#!/usr/bin/env node\n'),
    buf.subarray(open + 1, close),
    Buffer.from('\n'),
  ]);
}

function main() {
  const [, , inFile, outFile] = process.argv;
  if (!inFile || !outFile) {
    console.error('usage: unwrap-cjs.cjs <input.js> <output.js>');
    process.exit(2);
  }
  fs.writeFileSync(outFile, unwrap(fs.readFileSync(inFile)));
  fs.chmodSync(outFile, 0o755);
}

if (require.main === module) main();

module.exports = { unwrap };
