import ast
import pathlib
import sys

RULE = "project imports first, then a blank line, then stdlib imports; each group sorted alphabetically"


def module_of(node):
    if isinstance(node, ast.ImportFrom):
        return node.module or ""
    return node.names[0].name


def is_project(module):
    return module == "pkg" or module.startswith("pkg.")


def lint(path):
    source = path.read_text()
    lines = source.splitlines()
    problems = []
    imports = [n for n in ast.parse(source).body if isinstance(n, (ast.Import, ast.ImportFrom))]
    seen_stdlib = None
    last = {True: None, False: None}
    for node in imports:
        module = module_of(node)
        project = is_project(module)
        if project and seen_stdlib is not None:
            problems.append(
                f"{path}:{node.lineno}: import order: project import '{module}' must come before stdlib import '{seen_stdlib}' ({RULE})"
            )
        if not project and seen_stdlib is None:
            seen_stdlib = module
            if last[True] is not None and lines[node.lineno - 2].strip() != "":
                problems.append(
                    f"{path}:{node.lineno}: import order: missing blank line between project and stdlib imports ({RULE})"
                )
        previous = last[project]
        if previous is not None and module.lower() < previous.lower():
            problems.append(
                f"{path}:{node.lineno}: import order: '{module}' must come before '{previous}' within its group ({RULE})"
            )
        last[project] = module
    return problems


def main():
    problems = []
    for path in sorted(pathlib.Path("pkg").glob("*.py")):
        problems.extend(lint(path))
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print("lint ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
