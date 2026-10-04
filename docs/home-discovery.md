# Library home and discovery

The library starts with the reader's next action rather than the catalog's
folder structure. Home shows up to four unfinished, recently used titles and
eight recently changed titles. A resume card follows the latest reading or
listening track; finishing that track removes the card from Continue while
leaving it available in History. Recent content uses publication change time,
falling back to creation time.

## Navigation

- Home: continue reading or listening, see recent updates, enter a series.
- All content: a flat catalog with search, visible reading-state shortcuts,
  metadata facets, and sorting. Previous grouping preferences cannot hide titles
  here. An empty result offers a direct return to the full catalog.
- Series: the existing collection hierarchy, retaining saved collapse choices.
  Search and filters expand matching series without overwriting those choices.

On iPhone and narrow iPad windows, labeled navigation and search remain at the
bottom, above the safe area. Search takes the full toolbar while editing with
an on-screen keyboard. Wider iPad windows and desktop use a persistent left
navigation rail with search above the catalog. Cards remain one-column on phones
and gain columns as available width increases. The catalog initially renders
40 titles, with an explicit control to load the next 40. Home uses illustrated
cards; the catalog uses dense title rows with author, series, resume position,
and explicit read/listen controls. This avoids decoding artwork while scanning
search results and keeps the illustrated resume surface intact. Home sections
are bounded.

Series names and ordering come from catalog metadata. No built-in subject
vocabulary, collection priorities, or inferred classification is introduced.
Artwork continues through the content-addressed replica. The implementation
changes the web bundle and uses the existing native interface.

## Community references

- [Plex recommendations](https://support.plex.tv/articles/manage-recommendations/)
  keep Continue Watching on Home. This motivates a stable resume entry point.
- [Kavita dashboard customization](https://wiki.kavitareader.com/guides/features/customization/)
  organizes discovery into streams and allows filters to become dashboard
  entries. LiveView adopts separate resume and recent streams; saved custom
  streams remain future work.
- [Kavita filtering](https://wiki.kavitareader.com/guides/features/filtering/)
  treats rich metadata as a discovery tool. LiveView keeps its existing
  catalog-derived facets and makes reading state available outside the sheet.
- [Material adaptive layout](https://m3.material.io/foundations/layout/canonical-examples/overview)
  distinguishes compact, medium, and expanded windows. LiveView adapts to window
  width, including iPad multitasking, rather than treating device names as fixed
  layouts.

These references inform the design; they do not establish that this specific
layout is optimal. Actual usage and the Simulator acceptance gate determine
whether the implementation is ready to release.

## Verification

The local `just verify` gate passes, including 120 web tests. Dashboard tests
cover rendition-specific resume order, completed and removed titles, timestamp
fallback, and non-mutating catalog sorting.

The final web bundle was inspected in the actual Simulator WKWebView with a
163-title catalog: iPhone at 402 px, iPad at 744 px, and a 1280 px wide viewport.
Light and dark layouts, global search with empty-result recovery, direct series
entry, and loading from 40 to 80 catalog entries were exercised. The wide
viewport check verifies responsive layout in WKWebView; it is not a desktop
browser test.

Each final catalog scroll capture recorded 600 animation-frame intervals while
two audio resources were streamed concurrently. iPhone measured p99 17 ms and
maximum 34 ms; iPad measured p99 17 ms and maximum 33 ms, with no gap above 50 ms.
The iPhone Home capture measured p99 17 ms and maximum 29 ms under the same load.
The static Simulator baseline was p99 17 ms. These captures are evidence for
this implementation and test environment, not a guarantee for every device.
