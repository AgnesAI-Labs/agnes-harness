/** Lookup tables for latex.ts: what each supported command, script character and letter style becomes. */

const table = (pairs: string): ReadonlyMap<string, string> =>
  new Map(
    pairs
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const at = pair.indexOf('=')
        return [pair.slice(0, at), pair.slice(at + 1)] as const
      }),
  )

export const GREEK = table(
  `alpha=α beta=β gamma=γ delta=δ epsilon=ϵ varepsilon=ε zeta=ζ eta=η theta=θ vartheta=ϑ iota=ι kappa=κ
   lambda=λ mu=μ nu=ν xi=ξ pi=π varpi=ϖ rho=ρ varrho=ϱ sigma=σ varsigma=ς tau=τ upsilon=υ phi=ϕ varphi=φ
   chi=χ psi=ψ omega=ω Gamma=Γ Delta=Δ Theta=Θ Lambda=Λ Xi=Ξ Pi=Π Sigma=Σ Upsilon=Υ Phi=Φ Psi=Ψ Omega=Ω`,
)

export const SYMBOLS = table(
  `times=× cdot=· div=÷ pm=± mp=∓ ast=∗ star=⋆ circ=∘ bullet=• oplus=⊕ otimes=⊗ cup=∪ cap=∩ wedge=∧ land=∧
   vee=∨ lor=∨ neg=¬ lnot=¬ setminus=∖ le=≤ leq=≤ ge=≥ geq=≥ ne=≠ neq=≠ approx=≈ equiv=≡ sim=∼ simeq=≃
   cong=≅ propto=∝ ll=≪ gg=≫ in=∈ notin=∉ ni=∋ subset=⊂ supset=⊃ subseteq=⊆ supseteq=⊇ forall=∀ exists=∃
   nexists=∄ emptyset=∅ varnothing=∅ infty=∞ partial=∂ nabla=∇ sum=∑ prod=∏ coprod=∐ int=∫ iint=∬ iiint=∭
   oint=∮ sqcup=⊔ bigcup=⋃ bigcap=⋂ to=→ rightarrow=→ leftarrow=← gets=← leftrightarrow=↔ Rightarrow=⇒
   Leftarrow=⇐ Leftrightarrow=⇔ iff=⟺ implies=⟹ mapsto=↦ uparrow=↑ downarrow=↓ longrightarrow=⟶
   longleftarrow=⟵ hookrightarrow=↪ ldots=… dots=… cdots=⋯ vdots=⋮ ddots=⋱ ell=ℓ hbar=ℏ Re=ℜ Im=ℑ aleph=ℵ
   angle=∠ perp=⊥ parallel=∥ mid=∣ top=⊤ bot=⊥ triangle=△ langle=⟨ rangle=⟩ lceil=⌈ rceil=⌉ lfloor=⌊
   rfloor=⌋ lbrace={ rbrace=} lbrack=[ rbrack=] vert=| Vert=‖ degree=° prime=′ therefore=∴ because=∵
   qed=∎ checkmark=✓ dagger=† ddagger=‡ ldotp=. colon=: dotsc=… dotsb=⋯ lt=< gt=>`,
)

/** Operator names that stay words (`\sin x` is `sin x`). */
export const FUNCTIONS = new Set(
  `sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln lg exp lim limsup liminf max min sup
   inf det dim ker gcd deg arg Pr hom mod bmod`.split(/\s+/),
)

/** Commands that put a space, or nothing, in the output. */
export const SPACES = new Map<string, string>([
  [',', ' '],
  [';', ' '],
  [':', ' '],
  [' ', ' '],
  ['!', ''],
  ['quad', '  '],
  ['qquad', '    '],
  ['thinspace', ' '],
  ['medspace', ' '],
  ['thickspace', ' '],
  ['enspace', ' '],
])

/** Escaped punctuation: `\{`, `\%` and the like are the character itself. */
export const ESCAPES = new Map<string, string>([
  ['{', '{'],
  ['}', '}'],
  ['%', '%'],
  ['$', '$'],
  ['&', '&'],
  ['#', '#'],
  ['_', '_'],
  ['|', '‖'],
])

/** Style commands whose argument is shown as it is. */
export const WRAPPERS = new Set(
  `mathrm mathbf mathit mathsf mathtt mathcal mathscr mathfrak boldsymbol bm textbf textit textrm textsf
   texttt operatorname mbox`.split(/\s+/),
)

export const BLACKBOARD = new Map(Object.entries({ R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', H: 'ℍ' }))

/** Combining marks for `\hat{x}` and friends. */
export const ACCENTS = new Map<string, string>([
  ['hat', '̂'],
  ['widehat', '̂'],
  ['bar', '̄'],
  ['overline', '̄'],
  ['tilde', '̃'],
  ['widetilde', '̃'],
  ['vec', '⃗'],
  ['dot', '̇'],
  ['ddot', '̈'],
])

const chars = (from: string, to: string): ReadonlyMap<string, string> => {
  const a = [...from]
  const b = [...to]
  return new Map(a.map((c, i) => [c, b[i] ?? c]))
}

export const SUPERSCRIPT = chars(
  '0123456789+-=()abcdefghijklmnoprstuvwxyzABDEGHIJKLMNOPRTUVW',
  '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ',
)

export const SUBSCRIPT = chars('0123456789+-=()aehijklmnoprstuvx', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')
