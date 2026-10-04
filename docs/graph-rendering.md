# The visual language, and where it comes from

Observed 2026-09-11 by rendering graphify's own `graph.html` and the prior
`IMPORT_GRAPH.html` in Chrome for Testing and reading the pixels, not by
reading the generator and imagining the result. graphify draws with
vis-network 9.1.6; we draw with sigma. "The monorepo" below is the private
repo this tool was first built against (SPEC.md). The values below are what to carry over,
the section after is what not to.

The dated sections below use the tab names of their day. Since 2026-10-04
(ADR-0013): `ours` is `import graph`, `map` is `folders`, `map · lines` is
`folders · size`, `map · edges` is `folders · imports`, and `graphify page` is
`symbol graph`. `graphify files`, graphify's renderer over our file graph, was
removed.

## Colour schemes

The table below is the dark scheme, which is also the system default when the
OS gives no answer. Light follows the same derivations on a `#eef0f4` ground:
the chrome flips through CSS tokens (`html.light` in `globals.css`, set by
next-themes, `system` by default with the pick in localStorage), while the
canvas repaints data colours in place (`SCHEMES` / `applySchemeColors` in
`graphModel.ts`). Tableau 10 needs no light variant -- it was designed on
white, so light keeps it raw where dark lifts it to full value; selection is
the value no cluster can claim on that ground (white / near-black); dimming
moves toward the canvas on both. A scheme change never rebuilds the layout,
resets the camera, or fetches: positions are scheme-independent. Shiki follows
with `github-light-default`. Two surfaces stay dark whatever the scheme: the
graphify framed pages (third-party rendering, verbatim) and `/curve-probe`
(a dev page).

## Measured values

| Thing | graphify | prior tool |
| --- | --- | --- |
| Canvas ground | `#0f0f1a` | same |
| Sidebar | `#1a1a2e`, 280px | same, 300px |
| Borders | `#2a2a4e` | same |
| Input ground / border | `#0f0f1a` / `#3a3a5e` | same |
| Text / muted / faint | `#e0e0e0` / `#aaa` / `#555` | same |
| Palette | Tableau 10, `#4E79A7` first | same |
| **Edge opacity** | **0.35** (0.7 for high-confidence) | **0.35** |
| Node size | `10 + 30 * (degree / maxDegree)` | 8 to 38 |
| Selected node | background `#ffffff`, border keeps cluster colour | same |
| Dimmed legend row | `opacity: 0.35` | same |
| Section headers | 13px, `#aaa`, uppercase, `letter-spacing: 0.05em` | same |

## The four decisions that do the work

**Edges at 0.35 opacity, never 1.0.** This is the whole "dimmed" effect and it
is the single most load-bearing value here. At 0.35 on a near-black ground the
edges stop being objects you read individually and become texture: what you
perceive is cluster shape, the gaps between clusters, and the few long bridges
that cross them. At full opacity the same graph is a grey felt mat with dots on
it. Verified by looking at both files at 1600x1000.

**Labels are suppressed for most nodes.** graphify sets `font.size = 0` for any
node below 15% of max degree, so only hubs are named when zoomed out and
everything else is named on hover. Without this, a thousand-node graph is a wall
of overlapping text. The zoomed-in screenshot shows what happens when the rule
is bypassed (the aggregated view labels everything): "Double", "Void",
"UUID" and "Never" collide over each other and none of them is worth reading.

**Physics runs, then stops.** forceAtlas2Based with
`gravitationalConstant: -60`, `centralGravity: 0.005`, `springLength: 120`,
`damping: 0.4`, `avoidOverlap: 0.8`, then 200 stabilisation iterations, then
`physics: false`. A graph that keeps simulating never feels settled and every
drag disturbs the whole layout. `hideEdgesOnDrag: true` on top of that: edges
vanish while panning, which is both a large perf win and visually calmer.

**Selection is white.** The selected node's fill goes `#ffffff` while its border
keeps the cluster colour. On a dark field with ten mid-chroma cluster colours,
white is the only value that cannot be confused with a category, so "which one
did I click" needs no searching.

Two smaller ones worth stealing: neighbour rows in the sidebar carry a
`border-left: 3px solid <that neighbour's cluster colour>` rather than a
separate dot element, and arrowheads are drawn at `scaleFactor: 0.5` so
direction reads without the heads dominating short edges.

## What not to carry over

**Ten colours cannot label 168 clusters.** Both files reuse the palette modulo
its length, so the legend has four different greys at four different sizes and
colour stops identifying anything past the first ten rows. Colour should encode
the top N clusters and everything else should share one deliberate "other"
colour, rather than silently wrapping.

**The ring of isolates eats the canvas.** Zero-degree files get flung to a
circle by ForceAtlas2 and occupy roughly 40% of the frame in both screenshots
while carrying no structure. They belong in a corner, a separate strip, or
behind a toggle.

**`(mixed)` is not a cluster name.** The prior tool's legend leads with
`(mixed)` at 485, 85, 71, 66, 56 and 52 files: six of its largest clusters are
unnamed. Already fixed on our side, `graphing.cluster_label` and
`graphing.disambiguate`.

**Do not embed file contents.** The prior tool is 11.9MB because 1,260 files
are inlined, and it took a tag-injection bug to get there. We fetch from
`GET /api/file/{key}`.

## Mapping onto sigma

sigma has no `font.size = 0` per node and no DataSet to mutate. The equivalents:

- **`labelRenderedSizeThreshold`** hides labels below a rendered node size, and
  because it is measured after zoom it does what graphify's degree rule does and
  more: zoom in and labels appear on their own. This replaces the 15%-of-max
  rule rather than reimplementing it.
- **`nodeReducer` / `edgeReducer`** are how dimming and focus happen. They are a
  pure function from state to display attributes, which is a better fit than
  vis-network's mutate-the-dataset approach: focus state lives in zustand and
  the reducer reads it, so there is no second copy of "what is highlighted".
- Sigma's own reducer example dims with `color: "#f6f6f6"`, a near-white for a
  light background. **On our ground that renders as glowing blobs.** Dimming
  here means moving toward `#0f0f1a`, not toward white.
- Edge colour carries the source file's cluster colour, pre-composited against
  the ground (`mixHex` in `graphModel.ts`, `RENDER.edgeGroundMix`). This is
  graphify's `inherit: "from"` carried over: vis-network tints each edge with
  its source node's colour at 0.7 opacity, and the uniform `#2b2b3a` era
  discarded that hue. Type-only edges mix further toward the ground so the
  filter's distinction stays visible. An `rgba()` alpha was tried first and
  sigma's line program did not visibly honour it.
- Layout is `graphology-layout-forceatlas2`. Run it in the worker, stop it after
  it settles, and keep the stop: the "physics runs then stops" rule above is not
  a vis-network detail.

## The bug this review found, in the tool being replaced

Line 233 of the predecessor script, `graphify-import-graph.py`, writes
`content: '\25b8'` inside a non-raw Python string. Python reads `\25` as an
octal escape, so the CSS receives `U+0015` followed by a literal `b8`, and every
row of the path filter renders `b8` where its disclosure triangle should be.
Visible in the screenshot, confirmed in the generated HTML as `content: '^Ub8'`.
The fix is `\\25b8` or `▸`.

## What building it actually taught, measured

Added 2026-09-11, after the first render came out as a white disc.

**Edge ink is alpha times thickness times arrowheads, and the note above only
named the first.** Keeping graphify's 0.35 while leaving edges at full thickness
with an arrowhead each turned 2,680 edges into a solid white mass. Base edges
are now thin, un-arrowed and pre-composited dark; direction and weight come back
only for a focused node's own edges, where there are a dozen.

**Sigma's line program did not visibly honour an `rgba()` alpha.** Edges
specified at 0.22 rendered as near-white. Since the ground is a known constant,
the colour is mixed by hand instead: `#8a8aa8` at 0.22 over `#0f0f1a` is
`#2b2b3a`. That is also one less thing for the renderer to interpret.

**The layout question was not a settings question.** Three rounds of tuning
ForceAtlas2 produced a hairball, and the reason is structural: the monorepo's 989
visible files are **174 connected components**, the largest holding 457 of them.
ForceAtlas2 applies no attraction between components, so one simulation over all
of them is 173 things flung outward with only gravity holding them in. Every
setting that stopped the escape did it by crushing the clusters inside the big
component, and every setting that let the clusters breathe let a dozen
components escape and take the frame with them, because the camera fits the
extent.

**The metric that says so is the silhouette** of the Louvain labels over the
drawn 2D positions: +1 means every file sits nearer its own cluster than any
other, 0 means they are visually indistinguishable, negative means interleaved.
Fill is the share of a 100x100 grid over the frame carrying any node, which is
what stops a high score earned by distant pinheads. On 989 files and 2,686
edges:

| layout | silhouette | fill |
| --- | --- | --- |
| one simulation, strongGravity g1 sr1 *(was shipped)* | **-0.074** | 0.074 |
| one simulation, plain gravity 1 | 0.526 | 0.011 |
| one simulation, linLog, 3000 iterations | 0.483 | 0.036 |
| one simulation, weights 10:1 intra:inter | 0.906 | 0.008 |
| **per component, packed, plain gravity 1** | **0.387** | **0.066** |

The shipped row is **negative**: the average file really was closer to some
other cluster than to its own. That is what "the clusters are not separated"
looks like as a number, and the earlier metric pair (separation and fill) missed
it because separation measured centroid distance over cluster spread, which a
few escaped components inflate without anything being separated on screen.

**Packing removes the competition instead of trading between the two.** Lay each
component out alone, scale it to a radius following its file count, pack the
circles greedily largest-first, and the per-component settings can then be the
plain ones. Inside the 457-node component, averaged over five seeds: plain
gravity 1 scores 0.23 at 600 iterations and gains nothing at 1200 or 2500;
`linLogMode` beats it only at 0.2 gravity and 2500 iterations, 0.276 for four
times the work, with a seed spread (0.19 to 0.36) wider than the gap it wins by.
`outboundAttractionDistribution` scored at or below zero at every iteration
count tried. So the earlier note that linLog "is widely described as the thing
that separates clusters and scored worst" was measuring linLog at 600
iterations, which is roughly a quarter of what it needs.

**Weighting intra-cluster edges above the ones that cross clusters scores
highest of anything measured, and is not used.** It lays the graph out according
to the answer the graph is supposed to be showing: a clustering that was wrong
would still draw as tidy separated balls, and the picture would stop being
evidence about the code.

**graphify's own settings say the same thing from the other end.** It runs
vis-network's `forceAtlas2Based` at `centralGravity: 0.005` -- effectively zero
-- with `gravitationalConstant: -60`, `springLength: 120` and `avoidOverlap:
0.8`. Nothing holds its components in frame either; what saves it is that its
graphs are one component's worth of a single package. Copying its numbers onto a
174-component graph reproduces the escape, which is why the numbers here are
measured rather than borrowed.

**Isolates are laid out separately, in a block at the drawing's own grain.**
Left in the simulation they have nothing attracting them, so repulsion alone
throws them into the ring that ate 40% of the canvas in both predecessors.
Sized off the drawing's extent rather than its grain -- the median
nearest-neighbour distance -- all 161 of them claimed as much frame as the
entire structure, which with a fitted camera is frame taken straight from the
clusters. Which side they sit on is chosen by whichever leaves the whole drawing
closest to square, for the same reason.

**Forcing labels on a focused neighbourhood re-creates the label soup.** It
reads correctly for a leaf file and turns a hub into overlapping white text:
`app/wire/index.ts` has over eighty neighbours. Past two dozen, the size
threshold decides as usual and the rest are read by hovering.

## Global simulation, September 2026

Added 2026-09-12, reversing the packing section above at the comparison's
request: side by side with graphify's files pane, separated blobs read as
"less data" next to its filled ball, and no packing parameter changes that
because packing caps every component at its file-count radius by construction.

One simulation over everything connected, `strongGravityMode` with gravity 1,
isolates still gridded beside the drawing. Uniform gravity was tried first at
1, 3 and 8: nearer each time, but still islands with voids -- disconnected
groups feel only gravity, so a flat pull drags them closer without ever fusing
them. Distance-proportional pull fuses them into one mass while barely touching
nearby structure, which is the shape a flat gravity cannot give. The -0.074
strongGravity row in the table above was measured with isolates inside the
simulation; they are out now, which is what kept the ring from coming back.

## Ink and islands, September 2026

Added 2026-09-14, after the section above failed to settle the same complaint.
The drawing still read as less data than graphify's files pane beside it, so
this time both panes were measured rather than looked at. Both draw 989 nodes
and 2,686 edges, confirmed from their own footers and from the two responses;
the panes are different widths, so counts below are normalised to one scale,
an edge's pixel count scaling with length and a disc's with area.

| | ours, before | graphify files |
| --- | --- | --- |
| rendered pixels per edge | 1.68 | 9.14 |
| rendered pixels per node | 20.4 | 9.8 |
| edges' share of the ink | 5.9% | 48.0% |
| ink over the drawing's own extent | 11.2% | 17.4% |

So the two renderers spend their ink in opposite proportions on identical
data. graphify's exporter writes `width: 2` at `opacity: 0.7` on every
`EXTRACTED` edge (`exporters/html.py`), which is every edge our file-level
graph hands it; ours were 0.35px hairlines. The eye reads a graph's quantity
off the edge fabric rather than off the dots, which is why moving the dots
closer in the section above changed the picture without answering the
complaint.

One more thing makes this drift with repo size rather than staying put: sigma
node sizes are SCREEN pixels and do not shrink as the camera fits more nodes,
while vis-network radii are graph units and do. The same pair of numbers
therefore reads heavier here the bigger the repo gets, and any future tuning of
`minNodeSize`/`maxNodeSize` should be judged on the largest repo in the picker,
not the smallest.

`edgeSize` 0.35 to 1.2 and node sizes 3-11 to 2.5-8 put the drawing at 17.5%
ink against graphify's 17.4%, and it still read as less. Ink per pixel was the
wrong last question: it says nothing about whether the ink is one thing or
many. On a 48x48 grid over each drawing's own extent, ours occupied 49.2% of
the cells in **31 separate blobs** with the largest holding 58% of them;
graphify's occupied 49.0% in 5, with the largest holding 89%. Same ink, same
occupancy, a field of islands against a continent.

The islands were bought deliberately: `clusterSpread`, added 2026-09-12 in the
section above, pushed every Louvain cluster radially out from the barycentre
to open boundary air. Removing it leaves the drawing at 54.7% occupancy with
**95.5% in one blob**, ahead of graphify on both. Colour already tells the
clusters apart, so the gap was paying for a distinction that was not in
danger.

One number stays stubbornly against us and is not ours to fix: nodes per unit
screen area, 20 against graphify's 54. That is the split view, not the
renderer. graphify's page carries its own 280px sidebar inside the frame, so
its drawing gets 473px of a 1013px-tall pane where ours gets 752px, and 989
nodes auto-fitted into a smaller box are necessarily closer together. Judge
density by occupancy and blob count, which are scale-free; per-area node
counts compare the panes, not the drawings.

## What 2,581 files did to both renderers, September 2026

Every number above was taken on the monorepo: 1,262 files, 989 drawn. A shallow
clone of langchain is twice that and the first repo here that neither renderer
was tuned against. Both panes drew the same 1,766 visible nodes and 3,642
edges, tests excluded, through the same shape parameters.

**sigma held; vis-network did not.** Our pane drew one continent with the
clusters legible by colour, plus a starburst of about 800 files on
`langchain_classic/_api/__init__.py`, which is langchain's deprecation shim and
a real architectural fact about that repo. graphify's file-level pane, the same
data through `graphify export html`, produced a dense unreadable knot in one
corner, a square packed grid of the 403 import-free files, and a dotted ring of
isolates around the outside. Nothing in it could be read.

That inverts the complaint this file's previous section is about. At 989 nodes
our drawing read as sparser than graphify's and three passes went into closing
that gap. At 1,766 the gap is the other way and it is not close. Both findings
are real, and the lesson is that a rendering judgement taken at one graph size
is evidence about that size: the September ink and island measurements stay
valid for a thousand-node repo and say nothing about this one.

**graphify's own page stops being a drawing of the code.** Its HTML exporter
caps at `MAX_NODES_FOR_VIZ = 5_000` and, past that, silently swaps the graph
for an aggregated community meta-graph. langchain's 32,913 symbols became
1,778 nodes in 1,778 communities, which is one node per community: a picture
of the partition rather than of the codebase, and at that community count no
more readable than what it replaced. The `graphify page` tab shows this
honestly and it is worth knowing before reading anything into that pane on a
large repo.

What is NOT settled here: whether `edgeSize: 1.2` is right at this density.
It was chosen against 2,686 edges and this is 3,642 in a tighter frame. The
drawing is readable, so nothing is obviously wrong, and no measurement was
taken.

## The fan-out, September 2026

`langchain_classic/_api/__init__.py` is imported by 818 files and imports
nothing back. ForceAtlas2 draws that as a shell rather than a disc, because a
leaf settles where its one edge's pull balances the repulsion of the 817 other
leaves on the same hub, and that balance point is the same distance for all of
them. Measured on langchain, before any of this:

- the leaves occupied an annulus from radius 28 to 57
- the inner 24% of that disc was empty
- their density was 0.107 per unit squared against 0.237 for the rest of the
  drawing, so the starburst was less than half as dense as everything else
- it took **25.9% of the drawing's extent** to show one fact

Each leaf now keeps the angle the simulation gave it, which is where the
simulation found room, and only its radius is reassigned: rank the leaves by
how far out they landed, then spread them over the disc as the square root of
rank, which is the uniform-density curve. The disc is sized to hold them at the
drawing's own nearest-neighbour grain, floored at one median edge length so a
fan of four keeps ordinary edges and is skipped, and never larger than what the
simulation already produced. After: radius 7 to 34, the hole down to 4%, and
**9.7% of the extent**. The rest of the drawing takes the freed space.

Two things make this safe where the deleted `clusterSpread` was not, and they
are worth stating because it is the same class of move, a geometric edit after
the simulation:

- **It only contracts.** A hub whose leaves already fit is skipped, so nothing
  is ever moved into anything.
- **The space it claims was measured empty first.** Inside the target radius
  of 33 on that hub there were 818 of its own leaves and zero other nodes.

The grid-occupancy and blob-count pair used earlier in this file is NOT what
decided it, and the reason is worth recording: those numbers reward spreading
nodes out, which is exactly what this undoes, and on five runs of the same
configuration they ranged 28 to 37 blobs and 35% to 64% largest-blob share.
Layout is randomly initialised, so every run is a different drawing and the
metric's seed spread is wider than any effect being looked for. It was settled
by looking at it, on langchain and on the monorepo, where the change is
invisible.

## The map, September 2026

A second drawing of the same analysis, on its own tabs: files packed into the
circles of the folders they live in, **no edges at all**.

The reason it is worth a tab rather than a setting is what edges cost. On
langchain the graph canvas carries 1,766 discs under 3,642 curves, and the
measurement earlier in this file is that the eye reads a graph's quantity off
the edge fabric. At that density the discs stop being individually visible, so
the one thing the graph tab cannot do is show every file at once. Drop the
edges and it can. Position then spends itself on the folder tree, and colour
carries the only import fact left, the Louvain community, which is what keeps
this from being a file browser: a folder whose dots are one colour is a place,
one with four is a pile. That is the question the monorepo's own twelve-file
directory ceiling asks, and the flat view cannot ask it because folder
membership is invisible there.

### Not sigma, and the reason is the unit system

The obvious build was sigma with a second canvas layered under it for the
rings, which is the usual trick. It is the wrong one here.

**sigma sizes nodes in screen pixels.** That is correct for a graph, where a
disc should stay legible at any zoom, and wrong for a map, where a folder
circle IS the container its children sit in and has to grow with the camera. A
sigma node cannot be that without a custom WebGL program, and the rings then
need the second canvas anyway, which leaves two coordinate systems to keep in
step on every camera frame. The second-layer trick exists because sigma owns
its canvas; owning the canvas removes the problem rather than solving it, and
the rings, the dots and the labels become three passes in one 2D transform.

Nothing here needs WebGL. Full redraw per frame, measured in Chrome for
Testing at 1400x1400: **0.6ms** for the monorepo (995 files, 186 folders) and
**1.0ms** for langchain (1,766 files, 315 folders), against a 16.7ms budget. A
deep zoom is cheaper still because the viewport cull stops descending.

`d3-hierarchy` does the packing and nothing else does anything. `d3-zoom` was
installed and then removed: its API is selection-based, this app holds no other
d3 selections, and the fly-into-a-folder animation would have pulled in
`d3-transition` on top. The camera is 60 lines of wheel, drag and a cubic tween.

### One dot per file, not one dot per KB

Both sizings ship, `map` and `map · lines`, because they disagree about what
the largest object in the repo is and neither is a refinement of the other.
Sized by lines, a folder's circle is how much code is in it; `ide-shell` is a
modest ball. Sized one-dot-per-file it is the largest pile in the monorepo, about
250 near-identical files, and `libs/langchain` becomes visibly hundreds of small
modules rather than a few big ones.

Uniform is the default and is the better instrument for a layout question: a
folder's radius becomes how many things live in it, and the colour proportion
inside it can be read honestly, because no dot is large enough to dominate the
impression. Two tabs rather than one tab with a toggle, so the split view can
hold any pair and the difference is read by looking.

### Three things the build found that the design did not

- **Labels were written across the dots.** The first pass placed every name at
  its circle's edge and the drawing read as clutter. Labels collided with each
  other hardly at all; they collided with the discs underneath. A label now
  refuses to sit on a dot, tested against a screen-space grid, and gets a second
  placement to try before it is dropped. Without that alternate the dot test
  swallowed most folder names, which is worse than a name sitting slightly off
  its own circle. This is the job sigma's `labelGrid` does for the other tab.
- **Uniform dots make a collapsed folder ambiguous.** A folder under 13 screen
  pixels draws as one dot in its dominant colour, and when every file is the
  same size, a larger dot would otherwise read as one unusually large file. They
  carry a ring: a ringed dot is a bag, a bare dot is a file.
- **Isolates cannot go through full value here.** The graph canvas lifts the
  neutral to full value like every other disc, which puts it a shade off white.
  There are 280 files with no import at all in the monorepo's 1,275, and at map
  density a field of near-white dots reads before any cluster does, besides
  colliding with the selection colour. The map draws them at the raw neutral.
  Same file, different ink in the two tabs, deliberately.

Also measured and not adopted: React's `onWheel` is attached passively, so
`preventDefault` inside it is ignored and every wheel turn warns. The listener
is registered natively with `{ passive: false }`.

### What the cursor answers that the picture cannot

The label pass drops any name that would sit on a dot. That is right for a
drawing read at a glance -- names written across the discs were the first thing
that made this look like clutter -- and it means at fit almost no file is
named. Hover fills exactly that hole: the circle under the cursor is ringed and
a chip beside it carries the name, with the containing directory under it in
the muted ink. The second line is not decoration. The monorepo has eleven files
called `index.ts` and two directories called `terminal`, so a bare name
identifies neither.

Two refusals make it honest rather than chatty. A drag drops the hover, because
a chip that names whatever slides under a finger holding the drawing is noise.
And an OPEN folder larger than the pane is refused: the cursor is then in the
gap between its dots, so naming it tells the reader where they already are and
rings a boundary that is off screen in every direction. A folder small enough
to take in whole is still named, which is how a coloured blob gets identified
at fit without clicking into it.

### A fourth, found on a retina screen the harness did not have

The first version cleared the canvas with `fillRect(0, 0, box.width,
box.height)` after resetting the transform to the identity, on a backing store
sized `width * devicePixelRatio`. At a ratio of 1 that is exactly right and the
whole thing is invisible; at 2 it clears a quarter of the canvas, draws the map
at half scale into that quarter, and anchors the wheel on pointer coordinates
that no longer mean what the drawing means. Folder rings at depth are stroked
far outside the pane, and every one that landed outside the cleared rectangle
stayed there -- so zooming laid down arc after arc until the drawing sat behind
a cage of them. It reads as a renderer that has stopped erasing, which it is.

The fix is one unit system: clear the WHOLE backing store in device pixels,
then set the transform to the device ratio and treat everything afterwards --
camera, labels, hit testing -- as CSS pixels. Two lines, and the interesting
part is why it survived a verification pass: Playwright defaults to
`deviceScaleFactor: 1`, so every screenshot taken while building this was of
the one case where the bug cannot appear. A canvas change now gets driven at 2
(`scratchpad/dpr-zoom.mjs`), because that is the screen it will be read on.

### Putting the edges back, and pushing most of them into the ground

The map began by dropping the edges, and the case for putting them back is that
the packing changed what an edge costs. On the sigma canvas the curves are what
the eye reads first, because the layout spreads related files apart and every
relation is a long line. On the packed map a file sits beside the files it
imports, so the great majority of edges are twenty pixels long and vanish into
their own folder. Drawn straight and unfiltered they are not a hairball, which
was the surprise; they are mostly invisible, with one bright beam through the
middle where the traffic actually is.

That is the finding, and it is a claim about the PACKING rather than about
edges: position is already carrying most of what the edges would say, so the
edges only earn their COLOUR where position does not. Measured on the monorepo,
2,589 of 2,710 edges never leave their package.

**The first version of this drew only the other 121, and that was wrong.** The
reasoning was sound and the result was not: a map whose overview is empty until
the cursor lands on something is making a claim about the cursor rather than
about the repo, and the 95% it dropped is the fabric that says a folder is
wired at all. So the package rule is the EMPHASIS rather than a filter. Every
edge is drawn; the ones that stay inside their package are a ground, and the
ones that leave carry full cluster ink on top. There is still no toggle,
because there is no longer anything to toggle -- both pictures are on screen at
once, in different weights, which is what the first version was trying to
choose between.

**The ground needed hue, not just less light.** It went in as one flat grey and
was invisible: grey on a near-black ground is not a colour, it is an absence,
and the file-to-file edges inside a folder were drawn and could not be seen,
which is the entire thing the ground exists to show. Each strand now takes its
own cluster's colour mixed 62% into the background. That keeps it a ground --
it is dark, and it never competes with the emphasis above it -- while giving it
something brightness could not: `terminal/vendor/xterm` reads as a warm brown
web inside its orange dots, `app/sidecar` as a red one inside its red.
A folder that is internally wired now looks it, at fit, without being touched.

**A package is derived, not configured.** Descend from the root for as long as
one directory holds nine tenths of the repo, and the children at that level are
the packages. The monorepo stops at the top level; langchain descends through
`libs/`, which holds 1,761 of its 1,766 files and is a wrapper rather than a
package. Without that descent langchain reports one package and no crossings at
all, which is true of the path strings and false about the repo.

**Three things the drawing needed that the maths did not.**

An edge ends on the circle the camera SHOWS. A folder under `COLLAPSE` is one
dot, its files are not drawn, and an edge into it has to end on the dot or it
ends in empty ground -- which reads as a broken layout rather than as a zoom
level. That rule now has one home, `COLLAPSE` in `mapLayout.ts`, because three
separate readers want it: the drawing, the cursor, and the edges.

`source-over`, not `lighter`. Additive stacking is the obvious choice on a dark
ground and it takes a busy trunk to pure white, which throws away the cluster
hue -- the only import fact the rest of the map carries. With plain alpha a
trunk saturates toward its own colour instead, so density still reads and the
colour survives.

And an edge is drawn only when one of its ENDS is on the pane. This was found
by driving it: at a deep zoom the chord of a bundle whose ends are both off
screen is a diagonal across everything, and a dozen of them are a hatch over
the dots that says nothing about what the reader is looking at. Culling by
endpoint turns the same drawing into "what connects to what is in front of me",
and it makes the deep zoom cheaper rather than more expensive. Measured in
Chrome for Testing at `deviceScaleFactor: 2`, 1,200x900: 60fps sustained on
the monorepo, langchain and reposhape, worst frame 19.5ms during a continuous
zoom burst on langchain (`scratchpad/edges-verify.mjs`).

**What the filter does to a small repo is not a bug.** reposhape itself
draws exactly one edge, from `export_contracts.py` to the generated
`contracts.ts`. That is the whole of what joins its two halves, and a tab that
says so in one curve is reporting rather than failing.

### The emphasis inverts for one circle

The package rule is right about the repo and wrong about a file. Point at
`mapEdges.ts` and its twelve imports into its own folder are most of the answer
to "what is this file", and every one of them is in the ground. So the circle
under the cursor takes the emphasis instead: every edge in and out of it,
crossing or not, at full ink while the crossings go flat with everything else.

**One `Path2D` per ink is what makes a ground a ground**, and it took a wrong
version to find it. Turning the overview down to 0.09 alpha did not turn the
drawing down. Each strand is its own `stroke`, so overlapping alpha stacks: on
langchain a fused trunk of twenty strands came back to full opacity while every
single crossing disappeared, and the dim had inverted the picture rather than
flattening it. A `stroke` of one accumulated path rasterizes as a single
coverage mask and therefore has no density at all, which is exactly what a
ground has to be -- and it is also what makes drawing every edge affordable,
since the whole ground is a stroke per cluster rather than per strand.
Grouping by ink keeps that property where nearly all the overlap is, inside one
community. Same property that changed the fitted picture when the endpoint cull
landed, used deliberately this time.

**Colour carries direction here and nowhere else in the tab.** Warm leaves,
cool arrives, and a bundle that fuses traffic running each way is the third
ink. That is not an inconsistency with the cluster colouring: the pack puts an
importer beside the thing it imports, so position cannot say which way round a
pair is, and the community colour is the same fact the rest of the map already
carries. The pair is deliberately outside the palette so a focused edge never
reads as somebody's cluster.

**A folder answers the same question one level up**, which matters more than it
sounds: at fit almost nothing under the cursor is a file, because the pack
collapses a folder too small to open into one dot and that dot is what a reader
points at. A folder's edges are the ones with exactly one end inside it. Edges
wholly inside are left out -- they are what the folder is made of rather than
what it is connected to, and at a collapse they would be curves from a dot to
itself anyway.

**The chip says how many, because the drawing cannot.** Bundling is what makes
this readable and it is also what stops it being countable: one curve from
`app` into a collapsed `sidecar` can stand for nine imports. So the chip
carries the two edge counts, each in its own ink, which doubles as the only key
the colours get.

**How loud a crossing is depends on how exceptional crossing is here.** The
share of edges that leave a package, measured over eight cached analyses, runs
from 0.8% to 38.5%: reposhape draws one crossing in 118 edges, the monorepo
121 in 2,710, langchain 1,296 in 3,642, with the graphify extractions of both
landing at 14.5% and 38.5%. Emphasis marks the unusual, so the alpha follows
that share -- 0.85 where crossing is rare and the few arcs are the answer to
"how is this repo joined at all", 0.5 where it is a third of the drawing and
calling it exceptional would be false.

This went in backwards first, and the render is what corrected it. The plan was
to push the GROUND further down on a busy repo, to widen the gap between the
two layers. At that mix langchain's file-to-file edges went invisible again,
which is the one thing the ground exists to show -- and the goal itself was
wrong. Where crossing is ordinary the gap SHOULD close, because the two layers
converging is the true report about that repo rather than a rendering failure.
The stats line carries the percentage for the same reason: a number that steers
the picture should not be left as arithmetic.

**A click leaves the subject behind**, because hover alone cannot answer the
question the edges pose: following a strand to its far end means looking away
from the dot holding the drawing up, and the drawing leaves with you. The pin
rides the gestures that already exist rather than adding one -- a file was
already being selected and opened, a folder already being flown into -- and
both now keep their edges. Flying in is the case that earns it: the folder
fills the pane, its own dots are what the reader is among, and the strands
leaving it are the only thing left saying where they came from. A pinned circle
has no cursor to sit beside, so its chip goes on the circle's own rim. Only on
this tab, because only here is the cursor carrying something that has to
survive it.

**The stats line says what a package turned out to be**, which nothing on
screen said before: `121 of them leave a package · 12 packages, top level` on
the monorepo, `1,296 of them leave a package · 7 packages under libs/` on
langchain. Those two numbers are 4% and 36% of each repo's edges, so the same
rule describes two very differently wired repos, and a reader who cannot see
which one they are in cannot read the emphasis. It is derived from the packing
rather than from the view, so the canvas reports it up rather than the sidebar
deriving it twice.

Measured in Chrome for Testing at `deviceScaleFactor: 2`, 1,200x900, drawing
every edge rather than the crossings alone (`scratchpad/focus-verify.mjs`,
`scratchpad/edges-verify.mjs`): median 16.6-16.7ms everywhere -- hover sweep,
pan and zoom, on the monorepo, langchain and reposhape, in both themes. Worst
frame 17.7ms on the monorepo and 23.1ms on langchain during a continuous zoom
burst, against 19.5ms when the same burst was drawing a twentieth of the edges.
Bundling is what pays for it: 3,642 edges fold to a few hundred distinct anchor
pairs at fit, because most of them start and end inside one collapsed folder
and fold away entirely. Geometry is cached on the circle as well as on the
camera scale, because the chip follows the cursor and a redraw therefore
happens on every pointer move; only a move to a DIFFERENT circle rebuilds.

**The monorepo's folder graph has no cycles in it**, which is the first thing
this tab reported that nothing else here knew. Zero mutual directory pairs at
any of depths 1, 2 or 3, against langchain's one (`libs/core` and
`libs/text-splitters` import each other). So the third ink is genuinely rare
rather than dead: on langchain it shows up as a twenty-pixel violet stub
between `jsx.py` and the sibling it imports back, two dots apart in the pack --
which is the thesis of the whole map arriving as a rendering detail.

### An arrow, because colour is a legend rather than a direction

The flow inks answered "which way" only in the sense that a key answers it: you
look warm up as leaving and cool up as arriving, every time, and it never
becomes automatic. Worse, they are stated relative to the subject, so the same
curve changes colour when the cursor moves to the circle at its other end. That
is a fine annotation and it is not a direction.

So the focus layer now ends each bundle in an arrowhead, **pointing at the
importer**. A bundle that runs both ways gets two, facing away from each other,
which is the case the colours handle worst -- `both` is a third hue to memorise
where two opposed arrows need nothing remembered.

That is the reverse of the usual dependency arrow, which points from a module
at the thing it depends on. It was built that way first and it was wrong here,
for two reasons that only showed up on the screen.

An arrow arriving at a circle has an obvious reading, "this comes into me", and
under the dependency convention that reading is exactly inverted: an arrow
landing on a file means the file is the one being depended ON. Pointing at the
importer makes the arrow say what the code does, `core` flowing into the
modules that read it.

And it puts the crowded end where the counts are bounded. A file can be
imported by anything; it can only import what somebody typed into it, and the
measurement is not close:

| | in-degree p99 / max | out-degree p99 / max |
| --- | --- | --- |
| reposhape | 13 / 13 | 15 / 15 |
| the monorepo | 32 / 248 | 16 / 41 |
| langchain | 37 / 839 | 14 / 26 |

Heads land on the circle they point at, so under the dependency convention a
hub collects one per importer -- 839 of them on one rim. Pointing at the
importer scatters those across the 124 directories they come from and leaves
the subject holding only the handful it imports.

Three things the geometry needed, none of them visible from the renderer:

- **The samples, which were being thrown away.** A `Path2D` is opaque once
  written, so `spline` now returns the polyline it traces. Nothing else could
  answer where the curve crosses a circle.
- **The drawn edge, which is not the radius.** A collapsed folder is filled at
  `r` and then ringed at `r + 2.6`, so a head clamped to `r` lands inside the
  ring it is pointing at. Edges draw UNDER the dots, so the head has to clear
  the ring entirely rather than sit tangent to it.
- **The angle off the curve, not off the chord.** A bundled strand is routed up
  to the lowest common ancestor and back down, so it arrives at an angle the
  straight line between the two circles knows nothing about.

**What the render decided.** Measured at `deviceScaleFactor: 2` in both themes.
Drawn the dependency way, `app/sidecar/src/config.ts` with 44 importers
had not one legible head, and `libs/langchain/langchain_classic/_api/__init__.py`
with 839 was a solid cyan ribbon with the heads inside it. Zoom did not help:
the hub was sampled at four scales and the ribbon is solid at all of them.
Pointing at the importer instead, config.ts reads -- its importers each carry
their own arrow, and the one thing it imports points into it.

The cause is structural rather than a matter of degree, which is why flipping
the convention fixes it rather than merely moving it. Bundles are keyed on the
pair of anchors, and for a file subject one of those anchors is always the
subject itself -- so every strand's NEAR end lands on one circle and every
strand's FAR end lands on a different one. The near end is therefore always the
crowded one, and the question is only which relation gets put there.

What it costs: hovering a hub now shows no arrows at all near the subject,
because they are out at the 124 importers and off the pane. That is the honest
report -- the previous drawing put an illegible crust there instead.

It is not a cost problem. 16.7ms median and 17.3ms worst under a synthetic
hover sweep over the 839-importer hub, which is the frame rate.

One guard came out of the render. A head is drawn at a constant screen size, so
on a dot smaller than the head is long it stops being an arrow aimed at
something and becomes a marker with a speck attached -- measured on
`langchain_text_splitters`, whose thirteen files are eight-pixel dots at fit.
Circles under `HEAD_LENGTH` in screen radius get no head, and the flow colour
and the chip still carry the direction there.
