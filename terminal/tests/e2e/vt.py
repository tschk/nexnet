import re


class Screen:
    def __init__(self, rows=24, cols=80):
        self.rows, self.cols = rows, cols
        self.grid = [[" "] * cols for _ in range(rows)]
        self.r = self.c = 0
        self.buf = b""

    def feed(self, data):
        self.buf += data
        text = self.buf.decode("utf-8", errors="ignore")
        self.buf = b""
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "\x1b":
                m = re.match(r"\x1b\[([0-9;?]*)([A-Za-z])", text[i:])
                if m:
                    self.csi(m.group(1), m.group(2))
                    i += m.end()
                    continue
                m = re.match(r"\x1b[\]P_^].*?(\x07|\x1b\\)", text[i:], re.S)
                if m:
                    i += m.end()
                    continue
                i += 2
                continue
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self.r = min(self.r + 1, self.rows - 1)
            elif ch >= " ":
                if self.c >= self.cols:
                    self.c = 0
                    self.r = min(self.r + 1, self.rows - 1)
                self.grid[self.r][self.c] = ch
                self.c += 1
            i += 1

    def csi(self, args, cmd):
        n = [int(x) if x.isdigit() else 0 for x in args.lstrip("?").split(";")] if args else []
        a = n[0] if n and n[0] else 1
        if cmd in "Hf":
            self.r = min(max((n[0] if n and n[0] else 1) - 1, 0), self.rows - 1)
            self.c = min(max((n[1] if len(n) > 1 and n[1] else 1) - 1, 0), self.cols - 1)
        elif cmd == "A":
            self.r = max(self.r - a, 0)
        elif cmd == "B":
            self.r = min(self.r + a, self.rows - 1)
        elif cmd == "C":
            self.c = min(self.c + a, self.cols - 1)
        elif cmd == "D":
            self.c = max(self.c - a, 0)
        elif cmd == "G":
            self.c = min(max(a - 1, 0), self.cols - 1)
        elif cmd == "J":
            mode = n[0] if n else 0
            if mode in (2, 3):
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
            elif mode == 0:
                for c in range(self.c, self.cols):
                    self.grid[self.r][c] = " "
                for r in range(self.r + 1, self.rows):
                    self.grid[r] = [" "] * self.cols
        elif cmd == "K":
            mode = n[0] if n else 0
            rng = range(self.c, self.cols) if mode == 0 else range(0, self.c + 1) if mode == 1 else range(self.cols)
            for c in rng:
                self.grid[self.r][c] = " "

    def text(self):
        return "\n".join("".join(row).rstrip() for row in self.grid).rstrip()
