/**
 * Socratic AI — Expert Rule Pack Registry
 *
 * Loads all rule packs from src/expert-rules/ and exports them as an array.
 * The Detector uses all packs' rubric questions in one prompt so it can
 * identify concerns from ANY mistake family. The trigger classifier
 * aggregates all trigger_keywords for event classification.
 */
import prematureComplexity from './premature-complexity.json';
import scopeCreep from './scope-creep.json';
import architectureContradiction from './architecture-contradiction.json';
import dependencySprawl from './dependency-sprawl.json';

export const ALL_RULE_PACKS = [
    prematureComplexity,
    scopeCreep,
    architectureContradiction,
    dependencySprawl,
];
