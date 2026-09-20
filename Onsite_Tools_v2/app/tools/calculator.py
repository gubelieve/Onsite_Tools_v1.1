"""Calculator - simple client-side calculator (kept from v1.1 for convenience)."""
import ast
import operator

TOOL = {
    "id": "calculator",
    "name": "Calculator",
    "category": "Utilities",
    "order": 90,
    "description": "Basic calculator. Expressions are evaluated safely on the server (numbers and + - * / ( ) only).",
    "client": "calculator",
    "fields": [],
    "columns": [],
    "runs": [],
}

_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.Mod: operator.mod, ast.USub: operator.neg, ast.UAdd: operator.pos}


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    raise ValueError("unsupported expression")


def calculate(params):
    expr = (params.get("expression") or "").strip()
    if not expr or not all(c in "0123456789+-*/.()% " for c in expr):
        return {"result": "Error"}
    try:
        value = _eval(ast.parse(expr, mode="eval"))
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        return {"result": str(value)}
    except (ZeroDivisionError, ValueError, SyntaxError, TypeError, OverflowError):
        return {"result": "Error"}


ACTIONS = {"calculate": calculate}


def run(ctx, params):
    ctx.set_columns(["Expression", "Result"])
    ctx.add_row({"Expression": params.get("expression", ""), "Result": calculate(params)["result"]})
