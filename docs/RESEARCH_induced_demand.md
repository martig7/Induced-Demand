# Modeling Induced Demand in Public Transit — Research Brief

Literature + implementable parameters for the Induced Demand mod. Scope is
strictly transit (rail/metro/bus). Compiled from a fan-out search → fetch →
adversarial-verification pass (25 sources, 112 extracted claims, 25 put through
3-vote verification).

**Confidence key:** ✓✓ = adversarially verified 3–0 · ✓ = verified 2–1 ·
○ = extracted from a named primary source but not put through verification
(verification budget ran out before these). Treat ○ numbers as "good leads, spot-check."

---

## 1. The studies to read (and which one is about mode share)

If you read only a few:

| # | Study | Why it matters for you |
|---|-------|------------------------|
| 1 | **Koppelman & Bhat (2006), *A Self-Instructing Course in Mode Choice Modeling: Multinomial and Nested Logit Models* (FTA)** | ← **This is the "how mode share factors in" reference.** Free, complete, implementable. Gives the exact MNL/NL utility equations *and* estimated coefficients from 5,029 SF Bay Area commute trips. Start here. |
| 2 | **Litman (VTPI), *Transportation Elasticities* / *Transit Price Elasticities and Cross-Elasticities*** | The practitioner elasticity bible — the single best source of codeable numbers (fare, service, frequency, cross-elasticities, induced-vs-diverted split). |
| 3 | **Litman (2022), *Valuing Transit Service Quality Improvements*** (Research in Transp. Economics) | The generalized-cost weighting that *connects* mode share to service quality: walk/wait valued 2–5× in-vehicle time, transfer penalties, crowding. |
| 4 | **Balcombe et al. (2004), *The Demand for Public Transport: A Practical Guide* (TRL 593)** | UK canonical default elasticities by mode and time horizon. |
| 5 | **Cervero — UCLA "Appendix A" elasticity review + Direct Ridership Models; Cervero & Lund BART *Travel Characteristics of TOD*; Cervero *Making the Most of Transit*** | The accessibility / land-use / TOD feedback that drives *long-run* induced demand, plus a worked generalized-cost formula. |
| 6 | **TCRP H-37 / TCRP Report 95** | Premium-transit mode-choice coefficients and service-quality elasticity chapters. |
| 7 | **El-Geneidy et al. (2014), *New evidence on walking distances to transit stops*** | Empirical catchment radii / walk-access. |

Full URLs in §8.

---

## 2. "Induced demand" in transit — definition & elasticities

Transit rarely uses the phrase "induced demand"; the same idea shows up as
**generated/induced ridership** from new service or improved accessibility,
captured by **elasticities**. The key distinction for your model: a service
improvement both **diverts** trips from other modes *and* **generates** brand-new
trips. Litman quantifies the split:

- When bus ridership rises from **lower fares, only 10–50% of added trips
  substitute for a car trip**; the rest shift from walking/cycling, ridesharing,
  or are newly induced travel. Conversely, when car use is discouraged (parking
  fees/tolls), **20–60% of the lost car trips shift to transit.** ✓✓ (Litman, VTPI `tranelas.pdf`)

**Elasticity values you can use** (1% change in X → e% change in ridership):

| Lever (X) | Elasticity | Source / conf. |
|-----------|-----------|----------------|
| **Service expansion** (vehicle-km/hours into new areas) | **+0.6 to +1.0** | Litman ✓✓ |
| **Service frequency** (headway) | **≈ +0.5** (more where service is sparse) | Litman ✓✓ / Evans (TCRP 95) ✓✓ |
| Frequency, *disaggregate* stop-level (Chicago bus) | **+0.26 to +0.28** (aggregate models overstate this) | RTD/Chicago study ✓✓ |
| Service supply (vehicle revenue hours), cross-section | **+0.98 to +1.10** | Taylor et al. 2009 ✓ / NTD model ✓✓ |
| **Fare** (short run) | **−0.2 to −0.5** (bus −0.28, rail −0.65; Goodwin 1992) | Litman ✓✓ |
| Fare, TRL 593 defaults | bus −0.4 SR / −1.0 LR; metro −0.3 SR / −0.6 LR | Balcombe/TRL ○ |
| **Transit travel time** | −0.13 (Portland) up to −0.6 to −2.0 generalized-cost (rail, TRL) | Dowling 2005 / TRL ✓ |
| In-vehicle time (peak) | −0.59 to −1.16 | Cervero review ✓✓ |
| Waiting time | −0.54 (Gaudry 1974) | Cervero review ✓✓ |
| **Station distance** (proximity) | −0.49 to −0.57 | Cervero review ✓✓ |

**Two rules of thumb that matter for the sim:**
- **Long-run elasticities are ~2–3× short-run** (Litman; Fearnley & Bekken LR/SR ratio ≈ 1.84) ✓✓ — i.e. induced demand accrues over time, not instantly.
- **Ridership is more sensitive to travel time than to fare**, and within travel time, **wait time hurts far more than in-vehicle time.** ✓✓

---

## 3. Mode choice / mode share — the core mechanism

This is the part you asked about specifically. Mode share is modeled with a
**discrete-choice (logit)** model: each mode gets a *utility* `V`, and the
probability of choosing it is the softmax over modes.

**Multinomial logit (MNL):**
```
Pr(i) = exp(V_i) / Σ_j exp(V_j)
```
with a linear-in-parameters mode utility, e.g. ✓✓ (Koppelman & Bhat):
```
V(drive)   = γ1·TravelTime_drive   + γ2·TravelCost_drive
V(transit) = ASC_transit + γ1·TravelTime_transit + γ2·TravelCost_transit + γ3·Frequency_transit
```
`ASC_transit` is an alternative-specific constant (transit's baseline
(dis)advantage vs. car all else equal).

**Estimated coefficients** you can drop in (Koppelman & Bhat, 5,029 SF Bay Area
home→work trips, 6 modes) ✓✓:
- Total travel time: **−0.0513 per minute**
- Travel cost: **−0.0049 per 1990 cent**
- Transit constant (vs. drive-alone): **−0.6709**
- Implied **value of time = 0.0513/0.0049 ≈ 10.4 ¢/min ≈ $6.26/hr** ✓ (≈ half the wage)

TCRP H-37 generic in-vehicle-time coefficient: **−0.034/min** (t = −7.1). ✓

**Nested logit (NL)** groups similar modes (e.g. bus + light rail in a "transit"
nest) so a new transit option draws disproportionately from other transit, not
evenly from all modes — worth it if you ever split transit into sub-modes. ○

**Why this gives you induced demand "for free":** when you improve transit
(lower in-vehicle/wait/access time, higher frequency), `V(transit)` rises, so
`Pr(transit)` rises — that's the **diverted** share. To also model **generated**
trips, add a "no-trip"/latent-demand alternative or apply the trip-generation
elasticity on top (improved accessibility → more total trips), consistent with
the 10–50% car-substitution figure in §2.

---

## 4. Time weightings & generalized cost (directly codeable)

Travellers don't value all minutes equally — this is how mode share responds to
*where* you cut time. Out-of-vehicle time (walking to the stop, waiting) is the
expensive part:

- **Walk + wait time ≈ 2–5× in-vehicle time** (Litman: 70–175% of wage vs ~35%
  for a comfortable seat). ✓✓
- **Transfer penalty ≈ 5–15 min of in-vehicle time** each (so a rider prefers a
  40-min one-seat ride over a 30-min ride with a transfer). ✓✓
- Crowding/standing multiplies the cost of in-vehicle time: seated ~×1.0,
  standing ~×1.3–1.8, crush ~×2–2.5 (Douglas 2006). ✓✓
- Out-of-vehicle valuation, recent US mode-choice models: **2.0–4.5× IVT**
  (Houston 2.58, Cleveland 2.13, Minneapolis 4.0–4.36, Chicago 3.41); Wardman's
  UK meta-analysis is lower (walk ×1.66, wait ×1.47). ✓✓

**Worked generalized-cost formula** (Cervero / UCLA Appendix A, Eq. 1) ✓✓:
```
TGC = { Walk_t·Walk_w + Wait_t·Wait_w + IVT_t·IVT_w + nTransfers·TP + ModeConst } · VOT + Fare
```
Example weights: IVT_w = 1.00, Walk_w = 1.66, Wait_w = 1.47; VOT split so
in-vehicle ≈ $7.50/hr, walk ≈ $12.45/hr, wait ≈ $11.03/hr, transfer ≈ $1.32 each.
A common practitioner shortcut (PSRC SoundCast) just sets **walk = wait =
transfer-wait = ×2.0 IVT, and +8 min per boarding.** ○

---

## 5. Catchment & walk-access distance decay

How far people will walk to a stop, and how access probability decays with
distance — central to your station-catchment model:

- **Standard buffers: 400 m (¼ mi) for bus, 800 m (½ mi) for rail.** ½ mi ≈ a
  10-minute walk at 3 mph. ○ (TOD literature / WMATA: ½ mi rail, ¼ mi bus)
- **Empirically people walk farther than the buffers:** 85th-percentile walk is
  **~524 m to bus, ~1,259 m to commuter rail** (El-Geneidy et al. 2014, Montreal);
  median walk to Metrorail ≈ 0.35 mi. ○
- **The quarter-mile predicts station ridership about as well as the half-mile**,
  so a tighter catchment is defensible. ○
- **Distance decay shape:** a **Gaussian** decay fit station ridership best in
  Beijing (beat power, piecewise, and no-decay). ○ A practical decay is
  `weight(d) = exp(−(d/d0)²)` (Gaussian) or `exp(−β·t)` on walk *time*.

In your engine catchment is already a **walk-time** radius (base ~1800 s) — apply
a decay so a person 5 min away is weighted ~1.0 and someone near the 30-min edge
is weighted ~0, rather than a hard cutoff.

---

## 6. Accessibility / land-use feedback (long-run induced demand)

This is the slow loop that makes "induced demand" more than mode-switching:
better transit → more people/jobs locate near stations → more ridership.

- **People who live near stations ride transit ~5× the regional average.**
  Observed station-area commute transit mode share **26.5%** across sites (range
  3.3%–44.9%). ○ (Cervero & Lund, BART *Travel Characteristics of TOD*)
- **Station-level accessibility is about as important as land use** for
  explaining rail ridership (node-place model, J. Transport Geography 2023). ○
- New stations measurably raise nearby **density and employment growth** (Cervero,
  *Making the Most of Transit*). ○ — the residents/jobs growth your mod simulates.

For the model: tie demand-point growth to an **accessibility score** (e.g. the
logsum from the mode-choice model, or simply transit travel-time savings to jobs),
and let residents/jobs near high-accessibility stations grow over many days
(long-run elasticity), with the mode-share shift applied immediately (short-run).

---

## 7. How to operationalize in the sim

Mapping the findings onto your `DemandPoint` (residents/jobs) → `Pop`
(commuter groups, walk/drive/transit split) → station-catchment-by-walk-time model:

1. **Mode split per pop = a logit, not a threshold.** For each pop compute
   `V_transit`, `V_drive`, `V_walk` from its commute (in-vehicle time, wait =
   f(headway), access walk time, transfers, fare) using §3–§4 weights, then
   `P(mode) = softmax(V)`. The transit share of `pop.size` is your ridership.
   This makes ridership respond smoothly to every service improvement.

2. **Wait time from frequency.** Set wait ≈ ½·headway and weight it ~2× IVT;
   weight access-walk time ~2× IVT; add ~5–10 min-equivalent per transfer. These
   three are the biggest, cheapest-to-implement levers (§4).

3. **Catchment = weighted, not binary.** Weight each demand point's contribution
   to a station by a decay on walk time (Gaussian/exponential), base radius
   ~1800 s but effectively ~5–12 min for most riders (§5).

4. **Two-speed induced demand (§2 rule: LR ≈ 2–3× SR):**
   - *Short run (immediate):* the logit re-computes mode share when service
     changes — diverted demand. Calibrate so a 1% frequency gain ≈ +0.3–0.5%
     transit trips and time savings dominate fare.
   - *Long run (over in-game days):* grow `residents`/`jobs` of demand points in
     high-accessibility catchments toward a new equilibrium (and scale/add the
     `pops` anchored there — recall ridership comes from pops, not the aggregate
     counts). Cap so total induced growth respects the service-expansion
     elasticity (~0.6–1.0) rather than running away.

5. **Sanity rails from the literature:** transit mode share for strong
   station-area TOD tops out ~25–45%; only 10–50% of new transit trips come out
   of cars. Don't let a single great line drive unrealistic citywide mode shift.

---

## 8. Sources

**Verified, central:**
- Litman (VTPI), *Transportation Elasticities* — https://www.vtpi.org/tranelas.pdf · companion: https://vtpi.org/tdm/tdm11.htm
- Litman (2022), *Valuing Transit Service Quality Improvements* — https://www.sciencedirect.com/science/article/pii/S1077291X22002739
- Koppelman & Bhat (2006), *Mode Choice Modeling: MNL & Nested Logit* (FTA) — https://www.caee.utexas.edu/prof/bhat/COURSES/LM_Draft_060131Final-060630.pdf
- Cervero / UCLA elasticity review + generalized-cost formula — https://www.its.ucla.edu/wp-content/uploads/sites/6/2014/06/Appendix-A.pdf
- TCRP H-37 mode-choice coefficients — https://nap.nationalacademies.org/read/22401/chapter/13
- Disaggregate bus frequency elasticity (Chicago) — https://www.researchgate.net/publication/260183285
- US cross-sectional transit demand (NTD) — https://arxiv.org/pdf/2111.09126

**Catchment / land-use / TOD (extracted, spot-check):**
- El-Geneidy et al. (2014), walking distances to transit — https://link.springer.com/article/10.1007/s11116-013-9508-z
- Balcombe et al. (2004), TRL 593 *Demand for Public Transport* — https://www.trl.co.uk/uploads/trl/documents/TRL593%20-%20The%20Demand%20for%20Public%20Transport.pdf
- Cervero & Lund, BART *Travel Characteristics of TOD* — https://www.bart.gov/sites/default/files/docs/Travel_of_TOD.pdf
- Cervero, *Making the Most of Transit: Density, Employment Growth, Ridership* — https://www.researchgate.net/publication/254609470
- Node-place model & station ridership (2023) — https://www.sciencedirect.com/science/article/pii/S0966692323002119
- TOD half-mile standard — https://accessmagazine.org/spring-2013/half-mile-circle-right-standard-tods/ · WMATA walk-sheds — https://planitmetro.com/2014/06/10/whats-a-walk-shed-to-transit/
- TCRP Report 95 (service-quality elasticities) — https://onlinepubs.trb.org/onlinepubs/tcrp/tcrp_rpt_95c12.pdf

*Note: the 6 claims that failed verification (killed) were mostly duplicate/finer
statements about out-of-vehicle-time multipliers and transfer penalties whose
core point is already captured above via independently-verified sources.*
