/** Shared author instructions; the builtin creator embeds this through gen-assets.mjs. */
export const authoringGuidance = `Recommended authoring path: plugin_helper_guide(kind: tool|skill|skin) → plugin_helper_create once → plugin_candidate_read/write on that candidateId → plugin_test(expectedHash) → plugin_install_local(expectedHash) to submit human review. Use only tools in the current catalog. plugin_creator_guide provides the fuller guide; plugin_scaffold is an alternative initial template step, never a recovery step. Compatibility aliases plugin_helper_install test/commit/status use the SAME candidateId as proposalId; commit means submit, never install. If a required tool or Host capability is unavailable, report that fact and keep the draft.
Report the actual receipt's operation, stage and candidateId. A successful create remains successful when write/test/submit later fails. Continue the same draft after a later-stage failure; read its current hash before editing or retrying. Do not create a duplicate unless the human explicitly requests a new draft. Distinguish unavailable-host-capability, permission-denied, stale-hash and validation-failure; never invent settings/switches or infer “admin disabled” from an unavailable port. Never bypass a refusal with shell/config edits.
Report stages separately: draft generated; structure validated (only with explicit validation evidence); candidate test passed (exact hash, at least one executed test); install verified (actual installed/runtime evidence); browser/appearance verified; published (only a published receipt). A JSON/path/CSS string-only test proves only its assertions, never install or appearance. Where browser checks cannot run in this session, say “browser/appearance not verified” and ask the human to check light and dark mode, disable the package and restore default appearance. Do not say “the skin is fine” from strings or backend status.
Before install instructions, check the real CLI executable/version and help, effective AGH_HOME, profile and daemon startup workspace without exposing credentials. This version supports agh dev <plugin-folder>, agh plugins add and agh plugins pack; dev requires a folder below the daemon startup workspace. Do not claim only update/uninstall exist or that stopping the server is required without runtime evidence. Only human administration installs/trusts/enables or publishes through the existing review flow.
For a downloadable result, read the complete same-hash candidate with plugin_candidate_read (assemble all pages first). Using ordinary authorized workspace writes, copy every sourceFiles entry with its relative path into a new staging directory OUTSIDE plugin/Skill discovery roots and the private AGH home. Never run its entry or lifecycle scripts. Run the verified CLI's agh plugins pack <staging-folder> <new-output.tgz> (plugin-pack.ts); do not hand-roll an archive. A skin package includes package.json, index.mjs, descriptor and all relative assets. Only after packing succeeds, call present with the workspace .tgz path (32 MiB maximum) to offer ONE complete directory archive. Loose CSS/JSON file cards and candidate-source.json are previews, not installable packages. If pack/present or workspace access is unavailable, report delivery not completed and retain the candidate. Packing/download is not installation, trust, browser verification or publication.
中文：按同一候选完成 指南→创建一次→读取/编辑→精确摘要测试→提交人工审阅。复述回执的操作、阶段和候选 ID；后续失败保留原草稿，不重复创建，不编造管理员开关。分别报告草稿、结构验证、候选测试、安装验证、浏览器外观验证和发布。字符串测试不能证明安装或外观；无法检查浏览器时明确“未验证”，请人工检查亮暗模式及禁用恢复。安装指导前核实实际 CLI、home、profile 和启动工作区。下载成品须从完整候选经现有 pack 路径生成含入口、清单、描述符和相对资产的目录压缩包，再用 present 交付；仍由人工通过现有管理流程安装或发布。`

/** These are tool-output claims, not persisted candidate state or authorization. */
export function verification(value) {
  const tests = value.tests
  return {
    draftGenerated: value.candidateId ? 'verified' : 'not-verified',
    structureValidated: value.preview?.blockers?.length === 0 ? 'verified' : 'not-verified',
    candidateTestPassed:
      tests?.state === 'passed' && tests.hash === value.candidateHash && tests.count > 0
        ? 'verified'
        : 'not-verified',
    installVerified: value.state === 'published' ? 'verified' : 'not-verified',
    browserAppearanceVerified: 'not-verified',
    published: value.state === 'published' ? 'verified' : 'not-verified',
  }
}
