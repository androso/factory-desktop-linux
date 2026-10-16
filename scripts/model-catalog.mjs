// This function is also embedded in the renderer. Keep it self-contained.
export function mergeDaemonModelCatalog(frontendModels, daemonModels) {
  const models = new Map((frontendModels ?? []).map((model) => [model.id, model]));
  for (const model of daemonModels ?? []) {
    // Custom models still pass through the desktop's separate policy/BYOK flow.
    if (model.isCustom === true || model.id.startsWith('custom:')) continue;
    const frontend = models.get(model.id);
    const merged = { ...frontend, ...model };
    if (frontend?.disabled === true || model.disabled === true) {
      merged.disabled = true;
      merged.disabledReason = model.disabled === true
        ? model.disabledReason
        : frontend.disabledReason;
    } else {
      delete merged.disabledReason;
    }
    models.set(model.id, merged);
  }
  return [...models.values()];
}
