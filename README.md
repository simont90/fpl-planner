# FPL Planner

A data-driven Fantasy Premier League squad optimiser and transfer planner. Static
site, no build step, no dependencies.

Every recommendation comes from an expected-points model whose output can be taken
apart: click any player and you get the component breakdown — appearance, goals,
assists, clean sheet, defensive contribution, saves, bonus, cards — that adds up to
his projection.

## Running it

```bash
npm run serve      # static site on http://localhost:3000
npm test           # 69 tests
npm run calibrate  # model diagnostics against last season
```

The API proxy is deployed at `https://fpl-planner.simontariq.workers.dev` and the
page uses it by default, so `npm run serve` is enough. To run the proxy locally
instead:

```bash
npm run worker                                  # wrangler dev
open 'http://localhost:3000/?api=http://localhost:8787'
```

`npm run deploy` pushes the worker to Cloudflare.

## What it does

**Squad** — builds the best legal fifteen: £100.0m, 2/5/5/3 by position, at most
three per club, a valid formation, captain and vice. The club cap is what makes
this a search rather than a sort, so the interface reports how many independent
restarts agreed on the answer. A suggestions panel below the pitch reads the same
projections and fixtures — fixture runs about to turn, blanks inside the horizon,
a bench player who has quietly overtaken a starter — in plain rules, not a model
of its own; every line traces back to a number already on screen elsewhere.

**Transfers** — ranks doing nothing, one, two and three transfers, and prices the
four-point hit against the gain over the horizon. The *marginal* column is the one
that answers "is the hit worth it": what that transfer adds after paying for
itself. Rolling a free transfer is credited too, so a marginal move has to beat
banking rather than merely beat zero.

**Chips** — scores Bench Boost, Triple Captain, Free Hit and Wildcard on one
scale: points added over playing the same gameweek without the chip.

**Vs field** — fantasy football is scored on rank, not points. This projects what
the average manager scores from ownership, and splits your squad into the picks
that gain on the field and the ones that lose to it.

**Players** — every player, sortable, with the full projection behind each and a
colour-coded fixture-difficulty ticker for the horizon ahead.

## How the model works

`js/model.js` builds a points-per-match figure from component parts and scales each
by the difficulty of the actual fixture. Point values are read from
`game_config.scoring` in the payload rather than hardcoded, so a mid-season rules
change follows automatically.

Some details that matter more than they look:

- **Goals conceded and saves are floor divisions, not rates.** A keeper making 1.6
  saves a match earns `E[floor(s/3)]` = 0.22 points, not `1.6/3` = 0.53. Dividing
  the mean instead was enough to rank keepers above defenders wrongly.
- **Defensive contribution is a threshold**, not a rate — points land only when a
  player crosses 10 (defenders) or 12 (everyone else) actions inside one match, so
  it is a Poisson tail probability.
- **Clean sheets are shrunk before the Poisson**, because goals cluster into
  blowouts rather than spreading evenly. The constant is fitted, and a test fails
  if the data stops supporting it.
- **Players with no Premier League record** — promoted clubs and new signings, 187
  of 587 in preseason — fall back to a price-implied estimate by default, because
  price is what FPL's own compilers expect of them. Both the rate *and* the minutes
  fall back together, and they are flagged `est` in the interface. Getting only half
  of that fallback right silently deletes a third of the game.
- **A third of those 187 get something better than a guess.** `fbref/match.mjs`
  matches them against last season's actual goals/assists/minutes, hand-captured
  from a Stathead subscriber's own Player Season Finder session (not scraped —
  Stathead lost its advanced-data license in January 2026, so xG and defensive
  actions aren't available for anyone anymore; only the basic box score survived).
  A matched player is flagged `fbref` instead of `est`, and his goals/assists rate
  comes from that record rather than his price, discounted for league strength.
  Re-run the capture and `npm run fbref:match` to refresh it; see the file for how.
- **Every current PL player gets a shots/conversion/tackles profile where FBref could
  be matched**, shown in the player modal as "Underlying" — 2025-26 only, and
  display context rather than a model input. It is *not* blended into scoring:
  FBref's Tkl+Int isn't the same definition FPL uses for `defensive_contribution`
  (no clearances, blocks or recoveries), and folding shot volume into the
  already-calibrated goals rate risks moving the bias/MAE the tests above hold it
  to. A stat missing from the capture renders as no tile, not a false zero.

Calibrated against ever-present starters, the model runs a bias of −0.05 points per
90 with a mean absolute error of 0.23 and a correlation of 0.94.

### Judging the calibration honestly

`npm run calibrate` compares modelled and actual points per 90, but only for
players who start most weeks and are rarely substituted. That restriction is the
whole point. Appearance points are paid per appearance, not per minute, so a player
with bench cameos banks points over very few minutes and his actual points-per-90 is
inflated for reasons that have nothing to do with the model. Filtering on
minutes-per-start does not remove it — the filter cannot see the extra appearances,
only their minutes. Sweeping from every player to genuine ever-presents moves the
apparent bias from −0.37 to −0.04, and midfielders from −0.47 to 0.00.

## What it cannot do

- **Price changes are dormant until the season starts.** Every transfer field in
  the preseason payload is zero, so there is no signal to read. The mechanism is
  built and fits its own threshold from observed changes; it begins working on its
  own once managers start transferring. FPL has never published the rule that moves
  prices and it is not derivable from the payload.
- **Effective ownership is modelled, not measured.** Ownership is real, from the
  API. Starting rates and captaincy shares are not published at all, so they are
  inferred, and every figure that depends on them is flagged `modelled`.
- **Blank and double gameweeks do not exist yet in preseason.** They are created
  later by cup progression and postponements. Until then the chip planner says so
  rather than inventing a timing edge.
- **Loading your real team needs a played gameweek.** FPL has no saved squad before
  the first deadline.
- **The optimiser is a search.** It reports how many restarts agreed; on the full
  £100m budget they agree unanimously. Very near the cheapest possible fifteen
  (below about £70m) the fill can give up a few hundred thousand short — far outside
  any real FPL budget.

## Layout

```
index.html          the interface
css/app.css         one stylesheet, light and dark
js/model.js         expected points, per player per fixture
js/optimiser.js     legal squads, best eleven, captain
js/transfers.js     transfer search, hit maths, selling prices
js/chips.js         chip valuation
js/market.js        price momentum, ownership, the field
js/api.js           the worker client
js/insights.js      squad suggestions — a rule-based read of projections + fixtures
js/app.js           rendering and wiring only, no arithmetic
worker/worker.js    CORS + edge cache in front of the FPL API
fbref/match.mjs      matches players to a hand-captured Stathead dataset
data/fbref.json      no-record players' fallback rate — fed into the model
data/fbref-pl.json   every PL player's shot/tackle profile — display only
test/               69 tests, run against a real API snapshot
```

Tests run against a real snapshot of the API rather than hand-written stubs,
because most of what can go wrong here is a wrong assumption about the shape of the
payload — and invented fixtures agree with whatever the code already believes.
