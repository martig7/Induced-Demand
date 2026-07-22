# Induced Demand 1.1.0

A ground-up rebuild of how induced demand grows: a transit-access field drives
where demand appears, new demand points are placed by subdividing existing ones.
Dense cities subdivide a little, but sparse cities subdivide a lot.

## New demand model: access-field infill

- Directional access from transit reachability: Residential demand keys on
  reachable jobs, commercial on reachable residents, computed over a
  route-aware station graph with schedule-derived wait/ride weights.
- Per-city density fit: induces pops realistically to the city's density.

## New points via Voronoi subdivision

- Demand points now materialize by subdividing the Voronoi cells of existing
  demand. Split pressure scales with how under-subdivided a cell is.

## Density-differential induction

- Population-density headroom gate on splitting: a cell stops accruing split
  pressure where local density already meets a target, so dense cities add few new
  points while sparse ones subdivide.
- Job agglomeration: job-dense land grows more jobs and gets a bigger cap, so
  a few centers concentrate instead of jobs spreading evenly.
- Tuned towards 20-25% induced growth on high density, ~50% on medium density, ~75% on low density.
  If you add a lot of access to an empty area, it can densify a lot further though.

## Overlay & display

- Access views: A continuous field that shows network access as a proxy for location attractiveness.
- Cells view:  Voronoi cells colored by split pressure which update daily.

## Performance

- Performance not too dissimilar from previous versions,
  with the caveat that every day at midnight the game slows for ~50 ms.
