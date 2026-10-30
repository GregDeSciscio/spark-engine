// Destruction (ADR-011): THE FINALS-style structural destruction as an engine subsystem.

export {
  Destruction,
  DESTRUCTION_ORDER,
  type DestructionCensus,
  type DestructionDeps,
  type DestructionEvents,
  type DestructionOptions,
  type NavSoup,
  type DestructionStats,
  type DestructionStructure,
} from './Destruction';
export { Destructible } from './components';
export { SharedBudget, budgetsOf, type BudgetMember, type DestructionBudgets } from './Budget';
export {
  DESTRUCTION_SOUND_NAMES,
  DESTRUCTION_VOICES,
  type DestructionSoundName,
  type DestructionSounds,
  type DestructionVoice,
} from './sounds';

// The layers, for games that assemble their own (and for tools and tests).
export {
  Debris,
  DEFAULT_DEBRIS,
  GONE,
  HULL_SHRINK,
  RUBBLE,
  STANDING,
  type BodyOrigin,
  type Census,
  type DebrisHit,
  type DebrisOptions,
  type DebrisSettings,
  type Fling,
  type Sink,
} from './Debris';
export { Hinges, DEFAULT_HINGES, type HingeOptions, type HingeSettings } from './Hinges';
export { ChunkMesh, CHUNK_PALETTE, pieceGeometry } from './ChunkMesh';
export { Rebar } from './Rebar';
export { DestructionFx, type FxDeps, type Heard } from './DestructionFx';
export { GravelField } from './Gravel';
export { SmokeSystem, type SmokeKind } from './Smoke';
export { InlineStrainHost, StrainWorkerPool, WorkerStrainHost, type StrainHost } from './strain/StrainHost';
export { StrainRunner, type StrainAnswer, type StrainEnvelope, type StrainInit, type StrainReply, type StrainRequest, type StrainStep } from './strain/StrainRunner';

// The engine-agnostic core: fracture, contacts, the strain solve. Plain typed arrays, no three, no Rapier.
export { prism, type Face as PieceFace, type Frame as PieceFrame, type Piece, type PieceKind, type PrismSpec, type Surface as PieceSurface } from './core/pieces';
export { findConnections, GROUND, type Connection, type ConnectionOptions } from './core/connections';
export { buildStructure, type StructureData } from './core/structure';
export {
  DEFAULT_STRAIN,
  StrainSolver,
  type ConnectionLoads,
  type NodeLoad,
  type StepResult,
  type StepTiming,
  type StrainOptions,
  type Strengths,
} from './core/strain';
export { fractureRect } from './core/fracture';
export { rng, type P2, type V3 } from './core/math';
export { buildBuilding, DEFAULT_BUILDING, type Building, type BuildingParams } from './core/building';
