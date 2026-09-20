import { readFile } from 'node:fs/promises';
import { ClipAssembler } from '../dist/clipping/clipper.js';
import { OpenCodeCliLlm, DEFAULT_LOCAL_MODEL } from '../dist/clipping/llm.js';

const VIDEO = process.argv[2] ?? 'jGazxDOdl1Y';
const LIMIT = Number(process.argv[3] ?? 2);
const model = process.env.WHOP_LLM_MODEL ?? DEFAULT_LOCAL_MODEL;

const spec = {
  campaignId: '0d921575-0f7b-4082-a7a9-79a9dcc72dba',
  extractedAt: new Date().toISOString(),
  extractor: { provider: 'hand-built-from-verified-facts', model: null, promptVersion: 'pilot' },
  language: null,
  minDurationSeconds: null,
  maxDurationSeconds: null,
  contentSelectionGuidance: null,
  forbiddenContent: null,
  forbiddenRules: {
    value: ['AI-generated content is not allowed', 'Logos are not allowed', 'Do not portray TJR negatively'],
    provenance: [{ sourceId: 'verified', line: null, quote: 'AI-generated content NOT allowed; logos NOT allowed; must not portray TJR negatively' }],
  },
  hookPolicy: null,
  editingRules: null,
  unstructuredRequirements: [{ text: 'Submit within 30 minutes of posting; audience >=50% US/CA/AU/UK/NZ; #TJR required.', provenance: [{ sourceId: 'verified', line: null, quote: 'verified campaign facts' }] }],
};

const started = Date.now();
const assembler = new ClipAssembler({ campaignId: spec.campaignId, llm: new OpenCodeCliLlm({ model }) });
console.log(`# cutting ${LIMIT} clip(s) from ${VIDEO} via ${model}`);

const result = await assembler.assemble({ id: VIDEO }, spec, {
  momentLimit: LIMIT,
  paddingSeconds: 4,
  outDir: `out/clips/pilot/${VIDEO}`,
});

console.log(`\n## audio\npath=${result.audio.path}\nduration=${result.audio.durationSeconds.toFixed(1)}s fromCache=${result.audio.fromCache}`);
console.log(`\n## transcript\nmodel=${result.transcript.model} lang=${result.transcript.language} segments=${result.transcript.segments} words=${result.transcript.words} duration=${result.transcript.durationSeconds.toFixed(1)}s offset=${result.transcript.offsetSeconds}`);
console.log(`\n## assumptions`);
for (const a of result.selection.assumptions) console.log(`- ${a.key} = ${a.value} :: ${a.reason}`);
console.log(`\n## clips (${result.clips.length})`);
for (const clip of result.clips) {
  const sidecar = JSON.parse(await readFile(clip.result.sidecarPath, 'utf8'));
  console.log(`\n### ${clip.result.outputPath}`);
  console.log(`hook=${clip.candidate.hookRating} reason=${clip.candidate.reason}`);
  console.log(`sourceAbsolute=${clip.snapped.start.toFixed(3)}-${clip.snapped.end.toFixed(3)}s fileRelative=${sidecar.timecodes.fileRelative.in.toFixed(3)}-${sidecar.timecodes.fileRelative.out.toFixed(3)}s fetch=${clip.fetch.start.toFixed(3)}-${clip.fetch.end.toFixed(3)}s`);
  console.log(`requested=${clip.result.expectedDurationSeconds.toFixed(3)}s ffprobe=${clip.result.actualDurationSeconds.toFixed(3)}s delta=${Math.abs(clip.result.expectedDurationSeconds - clip.result.actualDurationSeconds).toFixed(3)}s`);
  console.log(`excerpt=${JSON.stringify(sidecar.transcriptExcerpt.text.slice(0, 240))}`);
  console.log(`rulesChecked=${sidecar.specRulesChecked.join(',')} sidecar=${clip.result.sidecarPath}`);
}
for (const warning of result.warnings) console.log(`warning: ${warning}`);
console.log(`\ncompleted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
