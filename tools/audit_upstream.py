#!/usr/bin/env python3
"""Read-only security triage of archived upstream source.

This does not execute imported code and deliberately never prints secret values.
It is a triage checklist, not a proof of safety or a full dependency audit.
"""
from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SCOPES = (ROOT / "third_party",)
SENSITIVE = {".session", ".session-journal", ".pem", ".key", ".pyc"}
BOT_TOKEN = re.compile(r"(?<![\w])\d{7,10}:[A-Za-z0-9_-]{32,}(?![\w])")


def label(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def scan():
    counts = Counter()
    issues: list[tuple[str, int, str]] = []
    names = set()
    for scope in SCOPES:
        if not scope.exists():
            issues.append((label(scope), 0, "missing_source_scope"))
            continue
        for path in scope.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix in SENSITIVE or path.name in {".env", "credentials.json"}:
                issues.append((label(path), 0, "sensitive_file_in_archive"))
            if path.name == "requirements.txt":
                requirements = path.read_text(encoding="utf-8", errors="replace").lower()
                for name in ("pyrofork", "pyrogram", "telethon", "pyromod", "aiogram"):
                    if re.search(r"(?m)^\s*" + name + r"(?:[=<>!~\s]|$)", requirements):
                        names.add(name)
            if path.suffix != ".py":
                continue
            counts["python_files"] += 1
            source = path.read_text(encoding="utf-8-sig", errors="replace")
            if BOT_TOKEN.search(source):
                issues.append((label(path), 0, "token_shaped_literal"))
            if "session_string" in source or "SESSION_STRING" in source:
                counts["files_referencing_user_sessions"] += 1
            try:
                tree = ast.parse(source, filename=str(path))
            except SyntaxError as error:
                issues.append((label(path), error.lineno or 0, "syntax_error"))
                continue
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                name = node.func.id if isinstance(node.func, ast.Name) else (
                    node.func.attr if isinstance(node.func, ast.Attribute) else ""
                )
                if name in {"eval", "exec"}:
                    issues.append((label(path), node.lineno, "dynamic_code_execution"))
                if name == "join_chat":
                    issues.append((label(path), node.lineno, "auto_chat_join"))
                if name in {"run", "Popen", "call", "check_output"}:
                    if any(keyword.arg == "shell" and isinstance(keyword.value, ast.Constant)
                           and keyword.value.value is True for keyword in node.keywords):
                        issues.append((label(path), node.lineno, "shell_command_execution"))
    if len(names & {"pyrogram", "pyrofork"}) == 2:
        issues.append(("requirements.txt files", 0, "pyrogram_pyrofork_namespace_collision"))
    return counts, sorted(issues)


if __name__ == "__main__":
    counts, issues = scan()
    print("Python files examined:", counts["python_files"])
    print("Files mentioning session strings:", counts["files_referencing_user_sessions"])
    print("Findings by category:")
    for kind, count in sorted(Counter(kind for _, _, kind in issues).items()):
        print(" -", kind, count)
    print("Code findings (paths and line numbers only):")
    for path, line, kind in issues:
        print(" -", path + (":" + str(line) if line else ""), kind)
    if any(kind in {"sensitive_file_in_archive", "token_shaped_literal", "missing_source_scope"}
           for _, _, kind in issues):
        sys.exit(1)
