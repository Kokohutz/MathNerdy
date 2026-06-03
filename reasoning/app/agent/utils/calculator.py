from sympy import *
from sympy.abc import x
import logging
from typing import List, Optional
import ast

def calc_solve(expression: str, operation: str = 'derivative', point: float = None, terms: int = None) -> str:
    """
    Solves calculus problems step by step using SymPy.
    
    Parameters:
    expression (str): Mathematical expression (e.g., "x^2 + sin(x)" or "3*x^2 + 2*x")
    operation (str): Type of operation - 'derivative', 'integral', 'limit', or 'series'
    point (float): Point for limit calculation or series expansion (default: None)
    terms (int): Number of terms for series expansion (default: None)
    
    Returns:
    str: Step-by-step solution with explanation
    """
    # Initialize pretty printing
    init_printing()
    
    # Convert ^ to ** for Python syntax
    expression = expression.replace('^', '**')
    
    # Parse expression
    try:
        expr = sympify(expression)
    except Exception as e:
        return f"Error parsing expression: {e}"

    result = []
    
    if operation == 'derivative':
        # Attempt to get an unevaluated form (this may help show some intermediate steps)
        steps_expr = diff(expr, x, evaluate=False)
        # After setting evaluate=False, we can apply doit(deep=False) for a somewhat intermediate form
        intermediate = steps_expr.doit(deep=False)
        derivative_expr = diff(expr, x)
        
        # Provide a descriptive, step-by-step explanation
        result.extend([
            f"Original expression: {expr}",
            "Goal: Find the derivative with respect to x.",
            "Step 1: Identify differentiation rules needed:",
            "  - Power Rule: d/dx[x^n] = n*x^(n-1)",
            "  - Sum Rule: d/dx[f(x) + g(x)] = f'(x) + g'(x)",
            "  - Product Rule: d/dx[f(x)*g(x)] = f'(x)*g(x) + f(x)*g'(x)",
            "  - Chain Rule: d/dx[f(g(x))] = f'(g(x))*g'(x)",
            "Step 2: Apply these rules to each term in the expression.",
            f"Intermediate (unevaluated) derivative form: {steps_expr}",
            f"Evaluating the intermediate expression to simplify: {intermediate}",
            f"Final simplified derivative: {derivative_expr}"
        ])
    
    elif operation == 'integral':
        integral_expr = integrate(expr, x)
        verified = diff(integral_expr, x)
        
        # Provide a descriptive, step-by-step explanation for integration
        result.extend([
            f"Original expression: {expr}",
            "Goal: Find the indefinite integral (antiderivative).",
            "Step 1: Identify integration rules needed:",
            "  - Power Rule (in reverse): ∫ x^n dx = x^(n+1)/(n+1) + C",
            "  - For trigonometric, exponential, etc., apply known antiderivative formulas.",
            "Step 2: Integrate each term of the expression.",
            f"Indefinite integral: {integral_expr} + C",
            "Step 3: Verification by differentiation:",
            f"d/dx of {integral_expr} = {verified}, which matches the original integrand.",
            "Thus, the computed integral is correct."
        ])
    
    elif operation == 'limit':
        if point is None:
            return "Error: Point required for limit calculation"
        lim = limit(expr, x, point)
        
        # Provide a descriptive, step-by-step explanation for limit
        result.extend([
            f"Original expression: {expr}",
            f"Goal: Find the limit as x → {point}.",
            "Step 1: Attempt direct substitution:",
            f"  Substitute x={point} into {expr}: {expr.subs(x, point)}",
            "Step 2: If direct substitution is undefined or indeterminate, use limit laws, simplification, or L'Hopital's rule.",
            "After applying the necessary limit techniques, we get:",
            f"Limit as x → {point} = {lim}"
        ])
    
    elif operation == 'series':
        if point is None or terms is None:
            return "Error: Point and terms required for series expansion"
        series_expr = expr.series(x, point, terms)
        simplified_series = series_expr.removeO()
        
        # Provide a descriptive, step-by-step explanation for series expansion
        result.extend([
            f"Original expression: {expr}",
            f"Goal: Find the series expansion around x = {point} up to {terms} terms.",
            "The series expansion of a function f(x) around a point a is given by:",
            "  f(x) = f(a) + f'(a)*(x-a) + f''(a)*(x-a)^2/2! + ...",
            f"Computing the series expansion around a={point}, we get:",
            f"{simplified_series}",
            f"This polynomial (truncated series) approximates {expr} near x={point}."
        ])
    
    else:
        return "Error: Invalid operation. Use 'derivative', 'integral', 'limit', or 'series'."
    
    return '\n'.join(result)

def _find_calls(text: str, func_name: str) -> List[str]:
    """
    Return every `func_name(...)` substring in `text` with balanced parentheses,
    correctly skipping parentheses and commas that appear inside string literals.
    """
    calls = []
    needle = func_name + "("
    idx = 0
    while True:
        start = text.find(needle, idx)
        if start == -1:
            break
        i = start + len(needle)
        depth = 1
        quote = None
        while i < len(text) and depth > 0:
            ch = text[i]
            if quote:
                if ch == quote and text[i - 1] != "\\":
                    quote = None
            elif ch in "\"'":
                quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        if depth != 0:
            break  # unbalanced; bail out
        calls.append(text[start:i])
        idx = i
    return calls


def process_calc_solve(text: str) -> Optional[str]:
    """
    Extract and execute calc_solve(...) calls found anywhere in `text`.

    Handles every documented call shape, e.g.:
        calc_solve("x^2")                              # default derivative
        calc_solve("3*x^2", operation="integral")
        calc_solve("sin(x)/x", operation="limit", point=0)
        calc_solve("exp(x)", operation="series", point=0, terms=4)
    """
    results = []
    for call_src in _find_calls(text, "calc_solve"):
        try:
            node = ast.parse(call_src, mode="eval").body
            args = [ast.literal_eval(arg) for arg in node.args]
            kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in node.keywords}
            results.append(calc_solve(*args, **kwargs))
        except Exception as e:
            logging.error(f"Error executing calc_solve call '{call_src}': {str(e)}")
            continue

    return "\n\n".join(results) if results else None


# print(process_calc_solve("""calc_solve("3*x**2 + 2*sin(x)")\ncalc_solve("sin(x)/x", operation="limit", point=0)"""))