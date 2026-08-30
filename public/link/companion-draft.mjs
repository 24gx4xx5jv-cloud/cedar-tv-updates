const SECTIONS = Object.freeze(["presentation", "settings", "branches"]);

const clone = (value) => structuredClone(value);
const sectionsMatch = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const canMergeByID = (...values) => values.every((value) => (
  Array.isArray(value)
  && value.every((entry) => isRecord(entry) && typeof entry.id === "string")
  && new Set(value.map((entry) => entry.id)).size === value.length
));

const orderChanged = (baseline, candidate) => {
  const candidateIDs = new Set(candidate.map((entry) => entry.id));
  const baselineIDs = new Set(baseline.map((entry) => entry.id));
  const baselineCommon = baseline.map((entry) => entry.id).filter((id) => candidateIDs.has(id));
  const candidateCommon = candidate.map((entry) => entry.id).filter((id) => baselineIDs.has(id));
  return !sectionsMatch(baselineCommon, candidateCommon);
};

const mergeDraftValue = (baseline, local, native) => {
  if (sectionsMatch(local, baseline)) return clone(native);
  if (sectionsMatch(native, baseline) || sectionsMatch(local, native)) return clone(local);

  if (isRecord(baseline) && isRecord(local) && isRecord(native)) {
    const merged = {};
    const keys = new Set([...Object.keys(baseline), ...Object.keys(local), ...Object.keys(native)]);
    for (const key of keys) {
      const baselineHasKey = Object.hasOwn(baseline, key);
      const localHasKey = Object.hasOwn(local, key);
      const nativeHasKey = Object.hasOwn(native, key);
      if (baselineHasKey && !nativeHasKey) continue;
      if (baselineHasKey && !localHasKey) {
        merged[key] = clone(native[key]);
        continue;
      }
      if (!baselineHasKey) {
        merged[key] = clone(nativeHasKey ? native[key] : local[key]);
        continue;
      }
      merged[key] = mergeDraftValue(baseline[key], local[key], native[key]);
    }
    return merged;
  }

  if (canMergeByID(baseline, local, native)) {
    const baselineByID = new Map(baseline.map((entry) => [entry.id, entry]));
    const localByID = new Map(local.map((entry) => [entry.id, entry]));
    const nativeByID = new Map(native.map((entry) => [entry.id, entry]));
    const preferredOrder = orderChanged(baseline, local) && !orderChanged(baseline, native)
      ? local.map((entry) => entry.id)
      : native.map((entry) => entry.id);
    const orderedIDs = [...new Set([
      ...preferredOrder,
      ...native.map((entry) => entry.id),
      ...local.map((entry) => entry.id),
    ])];
    const merged = [];
    for (const id of orderedIDs) {
      const baselineEntry = baselineByID.get(id);
      const localEntry = localByID.get(id);
      const nativeEntry = nativeByID.get(id);
      if (baselineEntry && !nativeEntry) continue;
      if (baselineEntry && !localEntry) {
        merged.push(clone(nativeEntry));
        continue;
      }
      if (!baselineEntry) {
        merged.push(clone(nativeEntry || localEntry));
        continue;
      }
      merged.push(mergeDraftValue(baselineEntry, localEntry, nativeEntry));
    }
    return merged.map((entry, index) => (
      Object.hasOwn(entry, "position") ? { ...entry, position: index } : entry
    ));
  }

  // Both sides changed the same indivisible value. The newer native snapshot wins.
  return clone(native);
};

export const createCompanionDraft = (spaceID, revision, configuration) => ({
  spaceID,
  baseRevision: revision,
  baseline: clone(configuration),
  configuration: clone(configuration),
  nativeUpdatedSections: [],
});

export const createCompanionDraftForState = (
  spaceID,
  revision,
  canonicalConfiguration,
  pendingReplacement = null,
) => createCompanionDraft(
  spaceID,
  revision,
  pendingReplacement || canonicalConfiguration,
);

export const companionDraftDirtySections = (draft, comparison = draft?.baseline) => {
  if (!draft?.configuration || !comparison) return [];
  return SECTIONS.filter((section) => !sectionsMatch(
    draft.configuration[section],
    comparison[section],
  ));
};

export const companionDraftIsDirty = (draft, comparison) => (
  companionDraftDirtySections(draft, comparison).length > 0
);

export const companionConfigurationsMatch = (left, right) => (
  Boolean(left && right) && sectionsMatch(left, right)
);

export const updateCompanionDraftSection = (draft, section, value) => {
  if (!draft || !SECTIONS.includes(section)) return draft;
  return {
    ...draft,
    configuration: {
      ...draft.configuration,
      [section]: clone(value),
    },
  };
};

export const reconcileCompanionDraft = (draft, spaceID, revision, configuration) => {
  if (!draft || draft.spaceID !== spaceID) {
    return createCompanionDraft(spaceID, revision, configuration);
  }
  if (draft.baseRevision === revision) return draft;

  const rebasedConfiguration = mergeDraftValue(
    draft.baseline,
    draft.configuration,
    configuration,
  );
  const nativeUpdatedSections = SECTIONS.filter((section) => (
    !sectionsMatch(draft.configuration[section], draft.baseline[section])
    && !sectionsMatch(configuration[section], draft.baseline[section])
    && !sectionsMatch(rebasedConfiguration[section], draft.configuration[section])
  ));
  return {
    ...createCompanionDraft(spaceID, revision, configuration),
    configuration: rebasedConfiguration,
    nativeUpdatedSections,
  };
};

export const discardCompanionDraftChanges = (draft) => (
  draft
    ? createCompanionDraft(draft.spaceID, draft.baseRevision, draft.baseline)
    : draft
);

const characterCount = (value) => (typeof value === "string" ? [...value].length : 0);

export const companionDraftValidationIssues = (configuration) => {
  const issues = [];
  const name = configuration?.presentation?.name;
  if (typeof name !== "string" || name.length === 0 || name.trim() !== name || characterCount(name) > 128) {
    issues.push({
      section: "presentation",
      field: "profile-name-input",
      message: "Enter a profile name without leading or trailing spaces.",
    });
  }

  const language = configuration?.settings?.metadataLanguageCode;
  if (typeof language !== "string"
    || !/^[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    issues.push({
      section: "settings",
      field: "metadata-language",
      message: "Use a language code such as en, en-CA, or fr-CA.",
    });
  }

  if (Array.isArray(configuration?.branches)) {
    configuration.branches.forEach((branch, index) => {
      const title = branch?.title;
      if (typeof title !== "string"
        || title.length === 0
        || title.trim() !== title
        || characterCount(title) > 80) {
        issues.push({
          section: "branches",
          field: `branch-title-${index}`,
          branchIndex: index,
          message: `Enter a name for Home row ${index + 1} without leading or trailing spaces.`,
        });
      }
    });
  }
  return issues;
};

export const describeDirtySections = (sections) => {
  const labels = sections.map((section) => ({
    presentation: "Profile",
    settings: "Settings",
    branches: "Home",
  })[section]).filter(Boolean);
  if (labels.length === 0) return "All changes are saved.";
  if (labels.length === 1) return `Unsaved changes in ${labels[0]}.`;
  if (labels.length === 2) return `Unsaved changes in ${labels[0]} and ${labels[1]}.`;
  return `Unsaved changes in ${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}.`;
};

export const filterAvatarCatalog = (catalog, query) => {
  if (!Array.isArray(catalog)) return [];
  const normalizedQuery = typeof query === "string" ? query.trim().toLocaleLowerCase() : "";
  if (!normalizedQuery) return catalog;
  return catalog.filter((avatar) => (
    `${avatar.name} ${avatar.category || ""} ${avatar.source || ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
};
