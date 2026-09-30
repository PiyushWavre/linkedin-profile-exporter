(() => {
  'use strict';

  const PHASES = Object.freeze({
    PROFILE: 'profile',
    DETAIL: 'detail',
    PACKAGING: 'packaging',
    DOWNLOAD: 'download',
    RETURNING: 'returning',
    COMPLETE: 'complete',
    ERROR: 'error',
    CANCELLED: 'cancelled'
  });

  const TERMINAL = new Set([PHASES.COMPLETE, PHASES.ERROR, PHASES.CANCELLED]);
  const ALLOWED = Object.freeze({
    [PHASES.PROFILE]: new Set([
      PHASES.PROFILE,
      PHASES.DETAIL,
      PHASES.PACKAGING,
      PHASES.ERROR,
      PHASES.CANCELLED
    ]),
    [PHASES.DETAIL]: new Set([PHASES.DETAIL, PHASES.PACKAGING, PHASES.ERROR, PHASES.CANCELLED]),
    [PHASES.PACKAGING]: new Set([
      PHASES.PACKAGING,
      PHASES.DOWNLOAD,
      PHASES.ERROR,
      PHASES.CANCELLED
    ]),
    [PHASES.DOWNLOAD]: new Set([
      PHASES.DOWNLOAD,
      PHASES.RETURNING,
      PHASES.COMPLETE,
      PHASES.ERROR,
      PHASES.CANCELLED
    ]),
    [PHASES.RETURNING]: new Set([
      PHASES.RETURNING,
      PHASES.COMPLETE,
      PHASES.ERROR,
      PHASES.CANCELLED
    ]),
    [PHASES.COMPLETE]: new Set([PHASES.COMPLETE]),
    [PHASES.ERROR]: new Set([PHASES.ERROR]),
    [PHASES.CANCELLED]: new Set([PHASES.CANCELLED])
  });

  function normalize(job) {
    if (!job) {
      return job;
    }
    job.state_version = 2;
    job.phase ||= PHASES.PROFILE;
    job.events ||= [];
    job.completed_steps ||= [];
    job.updatedAt ||= Date.now();
    return job;
  }

  function canTransition(from, to) {
    if (!from) {
      return true;
    }
    return Boolean(ALLOWED[from]?.has(to));
  }

  function event(job, type, data = {}) {
    normalize(job);
    const entry = { type, phase: job.phase, at: Date.now(), ...data };
    job.events.push(entry);
    if (job.events.length > 120) {
      job.events = job.events.slice(-120);
    }
    job.updatedAt = entry.at;
    return entry;
  }

  function transition(job, to, data = {}) {
    normalize(job);
    const from = job.phase;
    if (!canTransition(from, to)) {
      event(job, 'STATE_TRANSITION_REJECTED', { from, to, ...data });
      return false;
    }
    if (from !== to) {
      job.phase = to;
      event(job, 'STATE_TRANSITION', { from, to, ...data });
    } else {
      event(job, 'STATE_CHECKPOINT', { from, to, ...data });
    }
    return true;
  }

  function step(job, name, data = {}) {
    normalize(job);
    if (name && !job.completed_steps.includes(name)) {
      job.completed_steps.push(name);
    }
    return event(job, 'STEP_COMPLETED', { step: name, ...data });
  }

  function isTerminal(job) {
    return TERMINAL.has(job?.phase);
  }

  globalThis.LinkedInJobState = {
    PHASES,
    TERMINAL,
    normalize,
    canTransition,
    transition,
    event,
    step,
    isTerminal
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.LinkedInJobState;
  }
})();
