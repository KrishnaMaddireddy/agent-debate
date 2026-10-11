// Deterministic arithmetic. Used by the calculate tool and by the grounding audit, which recomputes
// every claim with basis "arithmetic" instead of trusting the model's number (PRD §4). Browser-safe.

// Recursive-descent arithmetic: numbers, + - * / % ^, parentheses, unary minus, a few functions, k/m/b suffixes and %.
export function safeCalc(src) {
  const s = src.replace(/(\d),(?=\d{3}(?!\d))/g, "$1").replace(/×/g, "*").replace(/÷/g, "/").trim();
  if (!s) return { error: "empty expression" };
  if (s.length > 300) return { error: "expression too long" };
  let i = 0;
  const peek = () => s[i];
  const eat = (re) => { const m = s.slice(i).match(re); if (m && m.index === 0) { i += m[0].length; return m[0]; } return null; };
  const ws = () => { while (/\s/.test(s[i] || "")) i++; };
  const FN = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp, sin: Math.sin, cos: Math.cos, tan: Math.tan, min: Math.min, max: Math.max };
  const CONST = { pi: Math.PI, e: Math.E };
  function expr() { let v = term(); for (;;) { ws(); if (peek() === "+") { i++; v += term(); } else if (peek() === "-") { i++; v -= term(); } else return v; } }
  function term() { let v = factor(); for (;;) { ws(); if (peek() === "*") { i++; v *= factor(); } else if (peek() === "/") { i++; const d = factor(); if (d === 0) throw new Error("division by zero"); v /= d; } else if (peek() === "%" && !/^\s*[\d(]/.test(s.slice(i + 1)) === false) { i++; v %= factor(); } else return v; } }
  function factor() { const b = unary(); ws(); if (peek() === "^") { i++; return Math.pow(b, factor()); } return b; }
  function unary() { ws(); if (peek() === "-") { i++; return -unary(); } if (peek() === "+") { i++; return unary(); } return primary(); }
  function primary() {
    ws();
    if (peek() === "(") { i++; const v = expr(); ws(); if (peek() !== ")") throw new Error("missing )"); i++; return post(v); }
    const num = eat(/\d*\.?\d+(?:e[+-]?\d+)?/i);
    if (num != null) { let v = Number(num); const suf = eat(/[kmb](?![a-z])/i); if (suf) v *= { k: 1e3, m: 1e6, b: 1e9 }[suf.toLowerCase()]; return post(v); }
    const id = eat(/[a-z_][a-z0-9_]*/i);
    if (id) { const k = id.toLowerCase(); ws(); if (peek() === "(") { if (!FN[k]) throw new Error(`unknown function ${id}`); i++; const args = [expr()]; ws(); while (peek() === ",") { i++; args.push(expr()); ws(); } if (peek() !== ")") throw new Error("missing )"); i++; return post(FN[k](...args)); } if (k in CONST) return post(CONST[k]); throw new Error(`unknown name ${id}`); }
    throw new Error(`unexpected "${s[i] || "end"}" at ${i}`);
  }
  function post(v) { ws(); if (peek() === "%" && /^%\s*(?:[-+*/)^]|$)/.test(s.slice(i))) { i++; return v / 100; } return v; }
  try {
    const v = expr(); ws();
    if (i < s.length) throw new Error(`unexpected "${s[i]}" at ${i}`);
    if (!Number.isFinite(v)) throw new Error("not a finite number");
    return { value: Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : Number(v.toPrecision(12)) };
  } catch (e) { return { error: e.message }; }
}
