import assert from "node:assert/strict";
import test from "node:test";

import {
  companionConfigurationsMatch,
  companionDraftDirtySections,
  companionDraftIsDirty,
  companionDraftValidationIssues,
  createCompanionDraft,
  createCompanionDraftForState,
  describeDirtySections,
  discardCompanionDraftChanges,
  filterAvatarCatalog,
  reconcileCompanionDraft,
  updateCompanionDraftSection,
} from "../public/link/companion-draft.mjs";

const configuration = () => ({
  presentation: {
    name: "Living Room",
    avatarSymbol: "person.crop.circle.fill",
    theme: "system",
    badgeSelection: "builtIn",
  },
  settings: {
    metadataLanguageCode: "en-CA",
    topShelfPresentation: "automatic",
  },
  branches: [{
    id: "trending",
    title: "Trending",
    position: 0,
    isEnabled: true,
    preset: "trending",
    sourceKind: "catalog",
    presentationKind: "row",
  }],
});

test("tracks dirty sections inside one unified configuration draft", () => {
  const original = createCompanionDraft("space-a", 4, configuration());
  const changedPresentation = {
    ...original.configuration.presentation,
    name: "Den",
  };
  const withPresentation = updateCompanionDraftSection(original, "presentation", changedPresentation);
  const changedSettings = {
    ...withPresentation.configuration.settings,
    metadataLanguageCode: "fr-CA",
  };
  const unified = updateCompanionDraftSection(withPresentation, "settings", changedSettings);

  assert.deepEqual(companionDraftDirtySections(unified), ["presentation", "settings"]);
  assert.equal(companionDraftIsDirty(unified), true);
  assert.equal(unified.configuration.presentation.name, "Den");
  assert.equal(unified.configuration.settings.metadataLanguageCode, "fr-CA");
  assert.equal(original.configuration.presentation.name, "Living Room", "updates remain pure");
  assert.equal(describeDirtySections(companionDraftDirtySections(unified)), "Unsaved changes in Profile and Settings.");
});

test("a restored pending submission is the clean draft baseline", () => {
  const canonical = configuration();
  const pending = configuration();
  pending.presentation.name = "Den";
  pending.settings.metadataLanguageCode = "fr-CA";

  const restored = createCompanionDraftForState("space-a", 4, canonical, pending);

  assert.equal(restored.configuration.presentation.name, "Den");
  assert.equal(restored.configuration.settings.metadataLanguageCode, "fr-CA");
  assert.equal(companionDraftIsDirty(restored, pending), false);
});

test("pending confirmation compares every validated branch field", () => {
  const expected = configuration();
  const changedSource = structuredClone(expected);
  changedSource.branches[0].sourceKind = "native-provider";
  const changedPresentation = structuredClone(expected);
  changedPresentation.branches[0].presentationKind = "grid";

  assert.equal(companionConfigurationsMatch(expected, structuredClone(expected)), true);
  assert.equal(companionConfigurationsMatch(expected, changedSource), false);
  assert.equal(companionConfigurationsMatch(expected, changedPresentation), false);
});

test("ordinary reconciliation preserves edits and rebases untouched sections", () => {
  const original = createCompanionDraft("space-a", 4, configuration());
  const edited = updateCompanionDraftSection(original, "presentation", {
    ...original.configuration.presentation,
    name: "Den",
  });
  const nativeUpdate = configuration();
  nativeUpdate.settings.metadataLanguageCode = "es-MX";

  const rebased = reconcileCompanionDraft(edited, "space-a", 5, nativeUpdate);

  assert.equal(rebased.baseRevision, 5);
  assert.equal(rebased.configuration.presentation.name, "Den");
  assert.equal(rebased.configuration.settings.metadataLanguageCode, "es-MX");
  assert.deepEqual(companionDraftDirtySections(rebased), ["presentation"]);
  assert.equal(reconcileCompanionDraft(rebased, "space-a", 5, nativeUpdate), rebased);
});

test("reconciliation merges independent fields and lets native win direct conflicts", () => {
  const original = createCompanionDraft("space-a", 4, configuration());
  const locallyEdited = updateCompanionDraftSection(original, "presentation", {
    ...original.configuration.presentation,
    name: "Den",
  });
  const nativeUpdate = configuration();
  nativeUpdate.presentation.theme = "cedarNight";

  const merged = reconcileCompanionDraft(locallyEdited, "space-a", 5, nativeUpdate);
  assert.equal(merged.configuration.presentation.name, "Den");
  assert.equal(merged.configuration.presentation.theme, "cedarNight");
  assert.deepEqual(companionDraftDirtySections(merged), ["presentation"]);

  const conflictingNativeUpdate = structuredClone(nativeUpdate);
  conflictingNativeUpdate.presentation.name = "Native profile";
  const conflict = reconcileCompanionDraft(locallyEdited, "space-a", 6, conflictingNativeUpdate);
  assert.equal(conflict.configuration.presentation.name, "Native profile");
  assert.equal(conflict.configuration.presentation.theme, "cedarNight");
  assert.equal(companionDraftIsDirty(conflict), false);
  assert.deepEqual(conflict.nativeUpdatedSections, ["presentation"]);
});

test("reconciliation preserves independent branch fields by stable id", () => {
  const baseline = configuration();
  baseline.branches.push({
    id: "popular",
    title: "Popular",
    position: 1,
    isEnabled: true,
    preset: "popular",
    sourceKind: "catalog",
    presentationKind: "row",
  });
  const original = createCompanionDraft("space-a", 4, baseline);
  const localBranches = structuredClone(original.configuration.branches);
  localBranches[0].title = "Trending now";
  const locallyEdited = updateCompanionDraftSection(original, "branches", localBranches);
  const nativeUpdate = structuredClone(baseline);
  nativeUpdate.branches[1].isEnabled = false;

  const merged = reconcileCompanionDraft(locallyEdited, "space-a", 5, nativeUpdate);
  assert.equal(merged.configuration.branches[0].title, "Trending now");
  assert.equal(merged.configuration.branches[1].isEnabled, false);
  assert.deepEqual(companionDraftDirtySections(merged), ["branches"]);
});

test("branch reconciliation reindexes the final merged order", () => {
  const baseline = configuration();
  baseline.branches.push({
    id: "popular",
    title: "Popular",
    position: 1,
    isEnabled: true,
    preset: "popular",
    sourceKind: "catalog",
    presentationKind: "row",
  });
  const original = createCompanionDraft("space-a", 4, baseline);
  const localBranches = structuredClone(original.configuration.branches).reverse();
  localBranches.forEach((branch, index) => { branch.position = index; });
  const locallyEdited = updateCompanionDraftSection(original, "branches", localBranches);
  const nativeUpdate = structuredClone(baseline);
  nativeUpdate.branches.push({
    id: "new-native-row",
    title: "New in Cedar",
    position: 2,
    isEnabled: true,
    preset: "top-rated",
    sourceKind: "catalog",
    presentationKind: "row",
  });

  const merged = reconcileCompanionDraft(locallyEdited, "space-a", 5, nativeUpdate);
  assert.deepEqual(merged.configuration.branches.map((branch) => branch.id), [
    "popular", "trending", "new-native-row",
  ]);
  assert.deepEqual(merged.configuration.branches.map((branch) => branch.position), [0, 1, 2]);
});

test("discard restores every edited section", () => {
  const draft = createCompanionDraft("space-a", 4, configuration());
  draft.configuration.presentation.name = "Den";
  draft.configuration.branches[0].title = "Popular now";

  const discarded = discardCompanionDraftChanges(draft);

  assert.equal(companionDraftIsDirty(discarded), false);
  assert.equal(discarded.configuration.presentation.name, "Living Room");
  assert.equal(discarded.configuration.branches[0].title, "Trending");
});

test("returns focused validation issues for editable fields", () => {
  const invalid = configuration();
  invalid.presentation.name = " ";
  invalid.settings.metadataLanguageCode = "english!";
  invalid.branches[0].title = " Trending ";

  assert.deepEqual(companionDraftValidationIssues(invalid), [{
    section: "presentation",
    field: "profile-name-input",
    message: "Enter a profile name without leading or trailing spaces.",
  }, {
    section: "settings",
    field: "metadata-language",
    message: "Use a language code such as en, en-CA, or fr-CA.",
  }, {
    section: "branches",
    field: "branch-title-0",
    branchIndex: 0,
    message: "Enter a name for Home row 1 without leading or trailing spaces.",
  }]);
});

test("avatar filtering is safe before loading and honors the latest query", () => {
  const catalog = [
    { name: "Big Bird", category: "Sesame Street", source: "TV" },
    { name: "Chicken", category: "Netflix", source: "Streaming" },
  ];

  assert.deepEqual(filterAvatarCatalog(null, "bird"), []);
  assert.deepEqual(filterAvatarCatalog(catalog, "  NETFLIX "), [catalog[1]]);
  assert.equal(filterAvatarCatalog(catalog, ""), catalog);
});
