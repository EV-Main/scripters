[lean]: <oklch(0.6 0.15 300)> "Proof cited from Lean"
[fig]: <oklch(0.62 0.17 150)> "Carries a figure"
[layout="bfs"]: #

---

# The problem
Given y' = f(t, y), y(t₀) = y₀ with no usable closed form, compute y(t).

The course asks whether Euler is valid. A quoter asks whether its numbers are precise enough and fast enough.

Thesis: every stage of a quote is provably precise enough, and no implementation is ≥ 10× faster.

<div scope="talk"><time>1m 30s</time></div>
<div scope="paper">every card below is a paper section</div>

- [simplest scheme](#euler)

# Euler {.fig}
Explicit: yₙ₊₁ = yₙ + h·f(tₙ, yₙ). Implicit: yₙ₊₁ = yₙ + h·f(tₙ₊₁, yₙ₊₁).

Figure: euler_sim on v' = κ(θ − v), the equation used throughout.

<time>2m 30s</time>

- [how wrong per step?](#local-error)
- [how wrong for large h?](#stability)
- [implicit needs a solve](#newton)

# Local error
Taylor: τ = O(h²) per step, so the scheme is consistent.

Proof: inline, 3 lines.

<time>30s</time>

- [errors accumulate](#global-convergence)

# Global convergence {.lean}
|eₙ| ≤ C·h, by discrete Grönwall.

Proof: Lean [L3]; inline only the statement and the one-line idea.

<time>2m</time>

- [check the slopes](#convergence-experiment)
- [O(h) has an expansion](#richardson)

# Convergence experiment {.fig}
log–log error against h: explicit and implicit slope 1, Richardson slope 2.

<time>1m</time>

- [small h is not the whole story](#stability)

<div scope="paper">

# Richardson
2·y_{h/2} − y_h cancels the leading error term: O(h) → O(h²).

- [higher order by design](#runge-kutta)

# Runge-Kutta {.fig}
RK4 against Euler + Richardson on a work–precision plot.

</div>

# Stability {.lean}
Dahlquist y' = λy: explicit needs |1 + hλ| < 1, implicit is unconditional.

Stiff: |λ| large makes stability, not accuracy, bound the explicit h.

Proof: inline, 2 lines. Lean [L4].

<time>2m 30s</time>

- [our ODE is y' = λy shifted, λ = −κ](#mean-reverting-variance)
- [PDEs in space are stiff](#method-of-lines)
- [λ per Fourier mode](#fourier-modes)

<div scope="paper">

# Method of lines
Black–Scholes in spot becomes V' = A·V; explicit needs h ≤ ΔS²/(σ²S²). That is why implicit Euler and Crank–Nicolson exist.

- [jumps add a nonlocal term](#vg-pide)

# VG PIDE {.fig}
IMEX Euler: the dense jump integral explicit, the small-jump diffusion implicit. Cutting jumps at ε tightens the explicit h as ε → 0: infinite activity is the stiffness.

Figure: against the Madan–Carr–Chang closed form; then American options, where the closed form is gone.

# Fourier modes
φ' = ψ(u)·φ is y' = λy with λ = ψ(u). Brownian |ψ| ~ u² (stiff), VG |ψ| ~ (2/ν)·log u (barely stiff).

Unverified that the discretised operator keeps the log growth.

</div>

# Mean-reverting variance {.lean}
v' = κ(θ − v), exact v(t) = θ + (v₀ − θ)·e^{−κt}.

Explicit Euler stays ≥ 0 iff hκ ≤ 1; implicit always.

Proof: inline, 1 line each. Lean [L4].

<time>2m 30s</time>

- [real variance is noisy](#stochastic-variance)
- [what prices see is total variance](#total-variance-to-price)

# Stochastic variance {.lean .fig}
Brownian (CIR): Euler–Maruyama goes negative with P > 0 for every h [L12].

Gamma-driven (BNS, the VG clock): dv = −κv·dt + dz, and 𝔼[v] solves our ODE. Δz ≥ 0, so hκ ≤ 1 still keeps it positive: the deterministic theorem survives.

Figure: same h, CIR paths cross 0, gamma-driven ones don't.

Proof: gamma case inline (the ODE proof plus Δz ≥ 0). CIR: Lean [L12].

<time>3m</time>

- [what prices see is total variance](#total-variance-to-price)
- [pricing by simulation](#monte-carlo-cost)

<div scope="paper">

# Monte Carlo cost {.lean}
Weak order 1 plus s/√M sampling error ⇒ cost ~ ε⁻³ [L13]. Fourier pricing avoids it for vanillas.

</div>

# Total variance to price
w(T) = ∫₀ᵀ v dt feeds Black: C(F, K, w). The variance ODE produces a price; the quoter runs this backwards.

<time>1m</time>

- [market gives prices, we need σ](#implied-volatility)
- [how wrong is the price?](#option-price-error)

<div scope="paper">

# Option-price error {.fig}
Euler error in w carried through Black, against h.

</div>

# Newton {.lean}
The implicit step solves g(z) = z − yₙ − h·f(tₙ₊₁, z) = 0.

|eₖ₊₁| ≤ (M/2m)·eₖ²: correct bits double per step [L5].

<time>2m</time>

- [the same solver inverts Black](#implied-volatility)
- [how few evaluations can any method use?](#oracle-lower-bound)
- [cubic, and Black-specific](#halley-and-lets-be-rational)

<div scope="paper">

# Oracle lower bound {.lean}
Sign-only root-finding needs ≥ log₂(L/ε) evaluations [L11]; Newton is within c× of it.

- [a floor for the solver](#limits-of-optimisation)

# Halley and Let's Be Rational
Halley: cubic convergence. Jäckel: two iterations to machine precision for Black.

</div>

# Implied volatility {.lean}
C(σ) strictly increasing within no-arbitrage bounds ⇒ unique σ [L6].

Newton from σ_c = √(2|ln(F/K)|/T) converges monotonically [L7].

<time>2m 30s</time>

- [σ per strike → a surface](#calibration)
- [each stage has an error](#error-chain-and-tick-sufficiency)

<div scope="paper">

# Calibration
SVI against VG's 3-parameter smile (Fourier-priced); gradients by AD.

- [price and sensitivities](#greeks)

# Greeks {.lean}
Finite-difference error C·h² + u/h, optimum h* ∝ u^{1/3} [L9]; AD has no truncation term.

- [between recalibrations](#taylor-repricing)

# Taylor repricing {.lean}
Second-order reprice, remainder ≤ M·‖Δ‖³/6 [L8]: recalibrate once it nears the tick budget.

- [last stage before rounding](#error-chain-and-tick-sufficiency)

</div>

# Error chain and tick sufficiency {.lean .fig}
Figure: the pipeline IV → calibration → fair value + Greeks → Taylor reprice → round to tick.

Stage i: ‖F̃ᵢ − Fᵢ‖ ≤ εᵢ, Fᵢ is Lᵢ-Lipschitz ⇒ total error ≤ Σᵢ (∏_{j>i} Lⱼ)·εᵢ [L1].

Below the distance to the nearest tick boundary, the quote is identical [L2]; P(flip) ≤ 2ε/tick.

So each stage gets a precision target, past which effort is provably wasted.

Proof: [L2] inline, 3 lines. [L1] Lean, induction sketched.

<time>4m</time>

- [precise enough; fast enough?](#limits-of-optimisation)

# Limits of optimisation {.lean .fig}
T = T_wire + T_exchange + T_compute. Amdahl: speedup ≤ 1/(1 − p), p = T_compute/T measured [L10].

Solver side: within c× of the oracle bound [L11].

Figure: measured tick-to-quote split, and the IV solver latency distribution (p50 / p99 / p99.9).

Proof: Amdahl inline, 1 line.

<time>3m</time>

- [](#conclusion)

# Conclusion
Euler's validity questions (consistency, stability, positivity) come back as the quoter's: per-stage error budgets, and the Newton step.

<time>1m</time>
