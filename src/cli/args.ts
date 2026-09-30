/** Minimal flag parser. No dependency is worth adding for this. */
export interface Args {
  flags: Record<string, string>;
  positional: string[];
  has(name: string): boolean;
  str(name: string, fallback: string): string;
  num(name: string, fallback: number): number;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = "true";
        }
      }
    } else {
      positional.push(a);
    }
  }
  return {
    flags,
    positional,
    has: (n) => n in flags,
    str: (n, d) => flags[n] ?? d,
    num: (n, d) => {
      const v = flags[n];
      if (v === undefined) return d;
      const parsed = Number(v);
      return Number.isFinite(parsed) ? parsed : d;
    },
  };
}
