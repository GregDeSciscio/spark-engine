export {
  AudioSystem,
  AUDIO_ORDER,
  type AudioContextStateName,
  type AudioStats,
  type AudioSystemOptions,
  type SoundPlayAtOptions,
  type SoundPlayOptions,
  type Voice,
} from './AudioSystem';
export { BUS_NAMES, DEFAULT_MAX_VOICES, busGain, clamp01, effectiveGain, isBusName, type BusName, type BusState } from './Buses';
export { VoicePool, type VoiceSlot } from './VoicePool';
export {
  SoundGate,
  resolveSoundDefinition,
  semitonesToRate,
  varyPitch,
  varyVolume,
  type ResolvedSound,
  type SoundDefinition,
} from './SoundDefinition';
export { DEFAULT_SPATIAL, attenuation, inaudible, resolveSpatial, type DistanceModel, type ResolvedSpatial, type SpatialOptions } from './Spatial';
export { crossfadeGains, fadeCurve, intensityGain } from './Crossfade';
export { MusicPlayer, type MusicPlayOptions, type MusicPlayerStats, type MusicTrack, type MusicVoiceSource } from './MusicPlayer';
export { DeadVoice, LiveVoice, PendingVoice, type VoiceStartOptions } from './Voice';
export {
  bindAnimationEvents,
  bindPhysicsEvents,
  impactVolume,
  type AnimationBindingOptions,
  type EventAudioSink,
  type PhysicsBindingOptions,
  type PhysicsEventName,
} from './bindings';
export {
  PLACEHOLDER_NAMES,
  PLACEHOLDER_SAMPLE_RATE,
  PLACEHOLDER_SPECS,
  clearPlaceholderCache,
  noiseBuffer,
  renderAllPlaceholders,
  renderPlaceholder,
  type PlaceholderName,
} from './placeholders';
