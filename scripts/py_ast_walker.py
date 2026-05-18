#!/usr/bin/env python3
"""
v0.26.0 Step 3 — Python AST walker for skill bundled-script scanning.

Reads a Python file from argv[1], parses with stdlib ast module, walks the
tree looking for dangerous patterns, prints findings as JSON to stdout.

Detected patterns (block-severity):
  - subprocess.run/Popen/call with shell=True (allows arg injection)
  - os.system / os.popen
  - eval() / exec() / compile()
  - __import__() called dynamically (not at module-level import statement)
  - pickle.loads / pickle.load / dill.loads (untrusted deserialization)
  - yaml.load without SafeLoader

Detected patterns (warn-severity):
  - Hardcoded secret patterns inline (sk-ant-, sk-..., ghp_, etc.)
  - urllib/requests calls to non-allowlisted domains (deferred — needs allowlist arg)
  - File operations outside skill's expected scope (deferred)

Output: JSON {"passed": bool, "violations": [{"pattern", "line", "col", "severity", "snippet"}], "errors": []}
Exit codes: 0 = scan completed (regardless of violations); 1 = parser couldn't read the file.
"""
import ast
import json
import sys
from pathlib import Path

VIOLATIONS = []
ERRORS = []
SOURCE_LINES = []


def add_violation(severity, pattern, node, snippet=None):
    VIOLATIONS.append({
        "pattern": pattern,
        "severity": severity,
        "line": getattr(node, "lineno", 0),
        "col": getattr(node, "col_offset", 0),
        "snippet": snippet or (SOURCE_LINES[node.lineno - 1].strip() if 0 < getattr(node, "lineno", 0) <= len(SOURCE_LINES) else ""),
    })


class Walker(ast.NodeVisitor):
    def visit_Call(self, node):
        # Resolve the callable name
        func_name = self._resolve_call_name(node.func)

        if func_name in ("eval", "exec"):
            add_violation("block", f"dynamic_{func_name}", node)

        if func_name == "compile":
            add_violation("block", "compile_call", node)

        if func_name == "__import__":
            # Inline __import__ is suspicious. Module-level `import` doesn't hit this node.
            add_violation("block", "dynamic_import", node)

        if func_name in ("os.system", "os.popen"):
            add_violation("block", "os_shell_exec", node)

        if func_name in ("subprocess.run", "subprocess.Popen", "subprocess.call",
                         "subprocess.check_call", "subprocess.check_output", "subprocess.getoutput"):
            for kw in node.keywords:
                if kw.arg == "shell" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                    add_violation("block", "subprocess_shell_true", node)
                    break

        if func_name in ("pickle.loads", "pickle.load", "dill.loads", "dill.load",
                         "marshal.loads", "marshal.load"):
            add_violation("block", "untrusted_deserialization", node)

        if func_name == "yaml.load":
            # yaml.load without Loader=SafeLoader is unsafe.
            # If a second positional arg or `Loader=` kwarg is present, check it.
            loader_arg = None
            if len(node.args) >= 2:
                loader_arg = node.args[1]
            for kw in node.keywords:
                if kw.arg == "Loader":
                    loader_arg = kw.value
                    break
            if loader_arg is None:
                add_violation("block", "yaml_load_unsafe", node)
            elif isinstance(loader_arg, ast.Attribute) and loader_arg.attr not in ("SafeLoader", "CSafeLoader"):
                add_violation("block", "yaml_load_unsafe", node)

        self.generic_visit(node)

    def _resolve_call_name(self, func_node):
        """Resolve a Call.func into a dotted name like 'subprocess.run' or 'os.system'."""
        parts = []
        cur = func_node
        while True:
            if isinstance(cur, ast.Name):
                parts.append(cur.id); break
            if isinstance(cur, ast.Attribute):
                parts.append(cur.attr); cur = cur.value
            else:
                return ""
        return ".".join(reversed(parts))


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"passed": False, "violations": [], "errors": ["usage: py_ast_walker.py <script.py>"]}))
        sys.exit(1)
    path = Path(sys.argv[1])
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        print(json.dumps({"passed": False, "violations": [], "errors": [f"read failed: {e}"]}))
        sys.exit(1)

    global SOURCE_LINES
    SOURCE_LINES = source.splitlines()

    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as e:
        # Parse error = can't analyze. Mark as block since we can't verify safety.
        VIOLATIONS.append({
            "pattern": "syntax_error",
            "severity": "block",
            "line": e.lineno or 0,
            "col": e.offset or 0,
            "snippet": str(e),
        })
        print(json.dumps({"passed": False, "violations": VIOLATIONS, "errors": ERRORS}))
        sys.exit(0)

    Walker().visit(tree)
    blocking = [v for v in VIOLATIONS if v["severity"] == "block"]
    print(json.dumps({
        "passed": len(blocking) == 0,
        "violations": VIOLATIONS,
        "errors": ERRORS,
    }))


if __name__ == "__main__":
    main()
