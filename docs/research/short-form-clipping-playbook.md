# Short-form clipping playbook

What the research says about holding attention in short-form video, and which
levers the clipping pipeline implements. Numbers here are the defaults in
`src/clipping/render.ts`; every one is overridable.

## Evidence

| # | Finding | Source | Pipeline lever |
|---|---------|--------|----------------|
| 1 | Attentional synchrony falls ~5% per extra second of shot duration; a cut raises it, peaking ~0.66s later. High-performing talking-head TikToks average 0.37 cuts/s (~1 per 2.7s). | Wals et al. 2025, *JAMS*, 42 videos / 2,520 eye-tracked viewings. [doi](https://doi.org/10.1007/s11747-025-01137-x); Dost & Huang 2026, N=242. [pdf](https://archives.marketing-trends-congress.com/2026/pages/PDF/paper_professor_DOST_HUANG.pdf) | `pacing`: visual change every 2.5–5.5s |
| 2 | Over-cutting backfires: higher editing density increases cognitive load and attentional disengagement; higher pacing reduces sustained engagement. | Lin & Cho 2026, *KSAF*. [doi](https://doi.org/10.17548/ksaf.2026.01.30.603); Dost & Huang 2026 | `minSecondsBetweenCuts` (2.5s), punch-in instead of hard cut |
| 3 | Captions improve attention, comprehension and memory across 100+ studies; +12% view time (Meta), 80% more likely to finish (Verizon/Publicis), +7.32% views (Discovery/3Play). Reading speed ≈ 3 words/s. | [NIH review](https://pmc.ncbi.nlm.nih.gov/articles/PMC5214590/) | 3-word cards, `minCardSeconds` 0.8s |
| 4 | Simple, centered scenes score ~12% higher synchrony; key element should be centered and uninterrupted for ≥1s at the start of a scene. ~3s per shot is needed to grasp content. | Wals et al. 2025; Song et al. 2023. [doi](https://doi.org/10.2298/csis220919017s) | Face-locked reframe, punch-in holds ≥2.5s |
| 5 | Music presence raises attention (EEG P300, alpha suppression); sound effects + music raised immersion up to ~4x; tempo is a null. | Kwon et al. 2022. [link](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2022.933497/full); Kock 2019. [link](https://emusicology.org/article/id/4555/) | Not yet implemented (campaign music rules permitting) |
| 6 | A punch-in zoom is a cut-equivalent attention reset without breaking continuity: 10–20% tighter, hold ≥3–4s. | Practitioner synthesis (autoclip, Zella) | `zoomAmount` 0.15, alternate base/punch |

## Defaults

```ts
pacing: {
  enabled: true,            // on when enhance=true
  minSecondsBetweenCuts: 2.5,
  maxSecondsBetweenCuts: 5.5,
  zoomAmount: 0.15,         // 15% punch-in
  minClipSeconds: 3,        // shorter clips stay one shot
  sentencePauseSeconds: 0.45,
}
captions: {
  maxWordsPerCard: 3,
  minCardSeconds: 0.8,      // ~3 words at 180 wpm
}
```

## Cut-point selection

1. Candidate boundaries are the first word after a sentence-ending punctuation
   mark or a pause longer than `sentencePauseSeconds`.
2. Walking from the clip start, each shot is cut at the candidate nearest the
   midpoint of `[min, max]`; when no candidate falls in the window, the cut is
   forced at `maxSecondsBetweenCuts`.
3. Shots alternate full frame / punch-in, so consecutive cuts change the framing
   rather than only the zoom level.
4. The last shot absorbs the remainder; total shot duration equals the clip
   duration exactly, so the ffprobe duration check still holds.

## Open items

- Sound design: whoosh/impact on beats, optional music bed (needs license).
- Beat detection from audio energy (currently cut points come from the
  transcript only).
- Per-clip pacing intensity keyed to the source's hype-potential grade.
