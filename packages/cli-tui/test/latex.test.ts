import { describe, expect, it } from 'vitest'
import { renderLatex } from '../src/latex.js'

const inline = (src: string) => renderLatex(src, { display: false })

describe('renderLatex', () => {
  it.each([
    ['\\alpha + \\beta', 'α + β'],
    ['\\Gamma \\Omega', 'Γ Ω'],
    ['a \\times b \\cdot c \\pm d', 'a × b · c ± d'],
    ['x \\le y \\ge z \\ne w \\approx v', 'x ≤ y ≥ z ≠ w ≈ v'],
    ['f \\to \\infty, A \\Rightarrow B', 'f → ∞, A ⇒ B'],
    ['x \\in A \\subset B, \\forall \\exists', 'x ∈ A ⊂ B, ∀ ∃'],
    ['\\partial \\nabla \\sum \\prod \\int', '∂ ∇ ∑ ∏ ∫'],
    ['\\sin x + \\log(y)', 'sin x + log(y)'],
    ['\\mathbb{R}', 'ℝ'],
    ['\\hat{x}', 'x\u0302'],
    ['50\\%\\ of \\{a\\}', '50% of {a}'],
  ])('converts %s', (src, out) => {
    expect(inline(src)).toBe(out)
  })

  it('turns spacing commands into spaces and drops \\left and \\right', () => {
    expect(inline('a\\,b\\;c\\quad d')).toBe('a b c d')
    expect(inline('\\left( x \\right) \\left. y \\right|')).toBe('( x ) y |')
  })

  it('uses Unicode scripts when every character has one, and ^(…) / _(…) when not', () => {
    expect(inline('x^2 + y_i')).toBe('x² + yᵢ')
    expect(inline('e^{n+1}')).toBe('eⁿ⁺¹')
    expect(inline('a_{12}^{-1}')).toBe('a₁₂⁻¹')
    expect(inline('x^{a+q}')).toBe('x^(a+q)')
    expect(inline('x_{b c}')).toBe('x_(b c)')
    expect(inline('x^\\alpha')).toBe('x^α')
    expect(inline('\\sum_{i=1}^{n}')).toBe('∑ᵢ₌₁ⁿ')
  })

  it('writes fractions as a/b, with parentheses only when needed', () => {
    expect(inline('\\frac{a}{b}')).toBe('a/b')
    expect(inline('\\frac{a+b}{c}')).toBe('(a+b)/c')
    expect(inline('\\frac{1}{\\sqrt{x+1}}')).toBe('1/(√(x+1))')
    expect(inline('\\frac{\\frac{a}{b}}{c}')).toBe('(a/b)/c')
  })

  it('stacks a lone fraction in display mode only', () => {
    expect(renderLatex('\\frac{a+b}{2}', { display: true })).toBe('a+b\n───\n 2')
    expect(renderLatex('1 + \\frac{a}{b}', { display: true })).toBe('1 + a/b')
  })

  it('writes square roots with parentheses only when needed', () => {
    expect(inline('\\sqrt{x}')).toBe('√x')
    expect(inline('\\sqrt{x^2+1}')).toBe('√(x²+1)')
    expect(inline('\\sqrt[3]{\\sqrt{2}}')).toBe('³√(√2)')
  })

  it('keeps the text of \\text, \\mathrm and \\mathbf', () => {
    expect(inline('x \\text{ if } y')).toBe('x if y')
    expect(inline('\\mathrm{d}x + \\mathbf{v}')).toBe('dx + v')
  })

  it.each([
    ['\\unknowncmd{x}'],
    ['\\begin{matrix} a \\end{matrix}'],
    ['\\frac{a}{b'],
    ['x^{2'],
    ['a}'],
    ['{a'],
    ['x^2^3'],
    ['\\hat{xy}'],
    // Untrusted model output: deep nesting and huge input fall back instead of exhausting the stack.
    [`${'{'.repeat(20000)}x${'}'.repeat(20000)}`],
    [`${'x^{'.repeat(65)}y${'}'.repeat(65)}`],
    ['x'.repeat(4097)],
    [''],
  ])('falls back to the source for %j', (src) => {
    expect(inline(src)).toBeUndefined()
    expect(renderLatex(src, { display: true })).toBeUndefined()
  })
})
