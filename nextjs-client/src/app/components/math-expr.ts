// Tiny safe math-expression engine for interactive plots.
//
// Parses "sin(a*x) + x^2/4" style expressions into an AST once, then evaluates
// it thousands of times per slider move. No eval(), no Function() — the
// tutor's LLM output is data, never code.
//
// Grammar: numbers, x, a, pi, e, + - * / ^, unary minus, parentheses, and
// sin cos tan asin acos atan exp log ln sqrt abs.

export type Expr =
  | { k: "num"; v: number }
  | { k: "var"; name: "x" | "a" }
  | { k: "neg"; e: Expr }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; l: Expr; r: Expr }
  | { k: "fn"; name: string; e: Expr };

const FNS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  log: Math.log,
  ln: Math.log,
  sqrt: Math.sqrt,
  abs: Math.abs,
};

export function parseExpr(src: string): Expr {
  let i = 0;
  const s = src.replace(/\s+/g, "").toLowerCase();
  if (!s) throw new Error("empty expression");

  const peek = () => s[i];
  const eat = (c: string) => {
    if (s[i] !== c) throw new Error(`expected '${c}' at ${i}`);
    i++;
  };

  function primary(): Expr {
    const c = peek();
    if (c === "(") {
      eat("(");
      const e = sum();
      eat(")");
      return e;
    }
    if (c === "-") {
      eat("-");
      return { k: "neg", e: primary() };
    }
    if (c === "+") {
      eat("+");
      return primary();
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(s.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      i += m[0].length;
      return { k: "num", v: parseFloat(m[0]) };
    }
    const word = /^[a-z]+/.exec(s.slice(i));
    if (!word) throw new Error(`unexpected '${c}' at ${i}`);
    const name = word[0];
    if (FNS[name] && s[i + name.length] === "(") {
      i += name.length;
      eat("(");
      const e = sum();
      eat(")");
      return { k: "fn", name, e };
    }
    if (name === "pi") {
      i += 2;
      return { k: "num", v: Math.PI };
    }
    // single-letter variables/constants, longest-name first failed above
    const ch = s[i];
    i++;
    if (ch === "x" || ch === "a") return { k: "var", name: ch };
    if (ch === "e") return { k: "num", v: Math.E };
    throw new Error(`unknown identifier '${name}' at ${i}`);
  }

  function power(): Expr {
    const base = primary();
    if (peek() === "^") {
      eat("^");
      return { k: "bin", op: "^", l: base, r: power() }; // right-assoc
    }
    return base;
  }

  function product(): Expr {
    let l = power();
    while (peek() === "*" || peek() === "/") {
      const op = peek() as "*" | "/";
      i++;
      l = { k: "bin", op, l, r: power() };
    }
    return l;
  }

  function sum(): Expr {
    let l = product();
    while (peek() === "+" || peek() === "-") {
      const op = peek() as "+" | "-";
      i++;
      l = { k: "bin", op, l, r: product() };
    }
    return l;
  }

  const e = sum();
  if (i !== s.length) throw new Error(`unexpected '${s[i]}' at ${i}`);
  return e;
}

export function evalExpr(e: Expr, x: number, a = 1): number {
  switch (e.k) {
    case "num":
      return e.v;
    case "var":
      return e.name === "x" ? x : a;
    case "neg":
      return -evalExpr(e.e, x, a);
    case "fn":
      return FNS[e.name](evalExpr(e.e, x, a));
    case "bin": {
      const l = evalExpr(e.l, x, a);
      const r = evalExpr(e.r, x, a);
      switch (e.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        case "^":
          return Math.pow(l, r);
      }
    }
  }
}

export function usesParam(e: Expr): boolean {
  switch (e.k) {
    case "var":
      return e.name === "a";
    case "num":
      return false;
    case "neg":
    case "fn":
      return usesParam(e.e);
    case "bin":
      return usesParam(e.l) || usesParam(e.r);
  }
}
