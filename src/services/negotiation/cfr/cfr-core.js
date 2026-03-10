/**
 * CFR+ Core Engine — Generic Counterfactual Regret Minimization
 *
 * Minimal, domain-agnostic CFR+ implementation in JavaScript.
 * Adapted from the production CardPilot poker CFR+ engine patterns.
 *
 * This module provides:
 *   - InfoSetStore: regret/strategy accumulation with Float32Array
 *   - cfrTraverse: generic recursive CFR+ tree traversal
 *   - solveGame: high-level solver loop
 *
 * To use for a specific domain (poker, procurement negotiation, etc.),
 * provide a game definition object that implements the GameDefinition interface.
 */

// ---------------------------------------------------------------------------
// InfoSetStore — regret & strategy accumulation (Float32Array for efficiency)
// ---------------------------------------------------------------------------

export class InfoSetStore {
  constructor() {
    /** @type {Map<string, Float32Array>} cumulative regrets per action */
    this._regrets = new Map();
    /** @type {Map<string, Float32Array>} cumulative strategy weights */
    this._strategies = new Map();
  }

  get size() {
    return this._regrets.size;
  }

  /** Get or create regret array for this info-set key. */
  getRegret(key, numActions) {
    let arr = this._regrets.get(key);
    if (!arr) {
      arr = new Float32Array(numActions);
      this._regrets.set(key, arr);
    }
    return arr;
  }

  /** Get or create strategy-sum array for this info-set key. */
  getStrategySum(key, numActions) {
    let arr = this._strategies.get(key);
    if (!arr) {
      arr = new Float32Array(numActions);
      this._strategies.set(key, arr);
    }
    return arr;
  }

  /**
   * Regret matching: convert cumulative regrets to current iteration strategy.
   * CFR+ floors regrets at 0, so all values are non-negative.
   */
  getCurrentStrategy(key, numActions) {
    const regret = this.getRegret(key, numActions);
    const strategy = new Float32Array(numActions);
    let sum = 0;

    for (let i = 0; i < numActions; i++) {
      strategy[i] = regret[i]; // already >= 0 in CFR+
      sum += regret[i];
    }

    if (sum > 0) {
      for (let i = 0; i < numActions; i++) strategy[i] /= sum;
    } else {
      const uniform = 1 / numActions;
      for (let i = 0; i < numActions; i++) strategy[i] = uniform;
    }

    return strategy;
  }

  /**
   * Get average strategy — the converged Nash equilibrium approximation.
   * This is the exploitable strategy to export and use at runtime.
   */
  getAverageStrategy(key, numActions) {
    const stratSum = this.getStrategySum(key, numActions);
    const strategy = new Float32Array(numActions);
    let sum = 0;

    for (let i = 0; i < numActions; i++) sum += stratSum[i];

    if (sum > 0) {
      for (let i = 0; i < numActions; i++) strategy[i] = stratSum[i] / sum;
    } else {
      const uniform = 1 / numActions;
      for (let i = 0; i < numActions; i++) strategy[i] = uniform;
    }

    return strategy;
  }

  /** CFR+ regret update: add delta and floor at 0. */
  updateRegret(key, actionIndex, delta, numActions) {
    const regret = this.getRegret(key, numActions);
    regret[actionIndex] = Math.max(0, regret[actionIndex] + delta);
  }

  /** Accumulate strategy weight for average strategy computation. */
  addStrategyWeight(key, actionIndex, weight, numActions) {
    const stratSum = this.getStrategySum(key, numActions);
    stratSum[actionIndex] += weight;
  }

  /** Iterate over all info-sets for export/inspection. */
  *entries() {
    for (const [key, stratSum] of this._strategies) {
      const numActions = stratSum.length;
      yield {
        key,
        numActions,
        averageStrategy: this.getAverageStrategy(key, numActions),
      };
    }
  }

  /** Estimate memory usage in bytes. */
  estimateMemoryBytes() {
    let bytes = 0;
    for (const arr of this._regrets.values()) bytes += arr.byteLength;
    for (const arr of this._strategies.values()) bytes += arr.byteLength;
    bytes += this._regrets.size * 100; // Map + string key overhead
    return bytes;
  }
}

// ---------------------------------------------------------------------------
// Generic CFR+ Traversal
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} GameNode
 * @property {'action'|'terminal'|'chance'} type
 *
 * For action nodes:
 * @property {number} player         - acting player (0 or 1)
 * @property {string[]} actions      - available actions
 * @property {Object<string, GameNode>} children - action → child node
 * @property {string} infoSetKey     - info-set key for this player at this state
 *
 * For terminal nodes:
 * @property {number[]} payoffs      - payoff per player (zero-sum: payoffs[0] = -payoffs[1])
 *
 * For chance nodes:
 * @property {Array<{prob: number, node: GameNode}>} outcomes
 */

/**
 * Recursive CFR+ traversal for two-player zero-sum games.
 *
 * @param {GameNode} node        - current game tree node
 * @param {InfoSetStore} store   - regret/strategy storage
 * @param {number} traverser     - player whose regrets we update (0 or 1)
 * @param {number} p0Reach       - player 0's reach probability
 * @param {number} p1Reach       - player 1's reach probability
 * @param {number} chanceReach   - chance node reach probability
 * @returns {number} expected value for the traverser
 */
export function cfrTraverse(node, store, traverser, p0Reach, p1Reach, chanceReach) {
  // Terminal node: return payoff for traverser
  if (node.type === 'terminal') {
    return node.payoffs[traverser];
  }

  // Chance node: weight outcomes by probability
  if (node.type === 'chance') {
    let ev = 0;
    for (const outcome of node.outcomes) {
      ev += outcome.prob * cfrTraverse(
        outcome.node, store, traverser,
        p0Reach, p1Reach, chanceReach * outcome.prob
      );
    }
    return ev;
  }

  // Action node
  const player = node.player;
  const numActions = node.actions.length;
  const infoKey = node.infoSetKey;

  const strategy = store.getCurrentStrategy(infoKey, numActions);
  const actionValues = new Float32Array(numActions);
  let nodeValue = 0;

  for (let a = 0; a < numActions; a++) {
    const child = node.children[node.actions[a]];

    const newP0 = player === 0 ? p0Reach * strategy[a] : p0Reach;
    const newP1 = player === 1 ? p1Reach * strategy[a] : p1Reach;

    actionValues[a] = cfrTraverse(child, store, traverser, newP0, newP1, chanceReach);
    nodeValue += strategy[a] * actionValues[a];
  }

  // Update regrets and strategy weights only for traverser's nodes
  if (player === traverser) {
    const opponentReach = player === 0 ? p1Reach : p0Reach;

    for (let a = 0; a < numActions; a++) {
      // CFR+ regret: counterfactual regret weighted by opponent reach
      const regret = actionValues[a] - nodeValue;
      store.updateRegret(infoKey, a, opponentReach * chanceReach * regret, numActions);

      // Accumulate strategy weight
      const playerReach = player === 0 ? p0Reach : p1Reach;
      store.addStrategyWeight(infoKey, a, playerReach * strategy[a], numActions);
    }
  }

  return nodeValue;
}

// ---------------------------------------------------------------------------
// High-Level Solver
// ---------------------------------------------------------------------------

/**
 * Solve a game tree using CFR+ for a given number of iterations.
 *
 * @param {GameNode} root        - root of the game tree
 * @param {InfoSetStore} store   - regret/strategy store (can be pre-populated)
 * @param {number} iterations    - number of CFR iterations
 * @param {Object} [options]
 * @param {function} [options.onProgress] - callback(iter, elapsedMs)
 * @param {number} [options.progressInterval] - iterations between progress callbacks
 * @returns {{ store: InfoSetStore, iterations: number, elapsedMs: number }}
 */
export function solveGame(root, store, iterations, options = {}) {
  const { onProgress, progressInterval = 1000 } = options;
  const startTime = Date.now();

  for (let iter = 0; iter < iterations; iter++) {
    // Traverse once per player as traverser
    cfrTraverse(root, store, 0, 1.0, 1.0, 1.0);
    cfrTraverse(root, store, 1, 1.0, 1.0, 1.0);

    if (onProgress && (iter + 1) % progressInterval === 0) {
      onProgress(iter + 1, Date.now() - startTime);
    }
  }

  return {
    store,
    iterations,
    elapsedMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Utility: compute game value and exploitability
// ---------------------------------------------------------------------------

/**
 * Compute expected game value using average strategies for both players.
 *
 * @param {GameNode} root
 * @param {InfoSetStore} store
 * @param {number} forPlayer - which player's EV to return
 * @returns {number} expected value for forPlayer
 */
export function computeGameValue(root, store, forPlayer) {
  return _gameValueTraverse(root, store, forPlayer);
}

function _gameValueTraverse(node, store, forPlayer) {
  if (node.type === 'terminal') {
    return node.payoffs[forPlayer];
  }

  if (node.type === 'chance') {
    let ev = 0;
    for (const outcome of node.outcomes) {
      ev += outcome.prob * _gameValueTraverse(outcome.node, store, forPlayer);
    }
    return ev;
  }

  const numActions = node.actions.length;
  const infoKey = node.infoSetKey;
  const avgStrategy = store.getAverageStrategy(infoKey, numActions);
  let ev = 0;

  for (let a = 0; a < numActions; a++) {
    const child = node.children[node.actions[a]];
    ev += avgStrategy[a] * _gameValueTraverse(child, store, forPlayer);
  }

  return ev;
}

/**
 * Compute best-response value for a player against the opponent's average strategy.
 *
 * For games with imperfect information, uses brute-force enumeration of all
 * pure strategies (one action per info set) for small games, falling back to
 * per-node max for larger games (upper bound).
 *
 * @param {GameNode} root
 * @param {InfoSetStore} store
 * @param {number} brPlayer - player computing best response for
 * @returns {number} best response value for brPlayer
 */
export function bestResponseValue(root, store, brPlayer) {
  // Collect all info sets for the BR player
  const infoSets = new Map(); // key → numActions
  _collectInfoSets(root, brPlayer, infoSets);

  const keys = [...infoSets.keys()];

  // For small games (≤ 20 info sets), enumerate all pure strategies
  if (keys.length <= 20) {
    const actionCounts = keys.map((k) => infoSets.get(k));
    const totalCombinations = actionCounts.reduce((p, c) => p * c, 1);

    if (totalCombinations <= 1_000_000) {
      return _bruteForceBestResponse(root, store, brPlayer, keys, actionCounts, totalCombinations);
    }
  }

  // Fallback: per-node max (upper bound on exploitability)
  return _perNodeMax(root, store, brPlayer);
}

function _collectInfoSets(node, brPlayer, infoSets) {
  if (node.type === 'terminal') return;
  if (node.type === 'chance') {
    for (const outcome of node.outcomes) {
      _collectInfoSets(outcome.node, brPlayer, infoSets);
    }
    return;
  }
  if (node.player === brPlayer && !infoSets.has(node.infoSetKey)) {
    infoSets.set(node.infoSetKey, node.actions.length);
  }
  for (const action of node.actions) {
    _collectInfoSets(node.children[action], brPlayer, infoSets);
  }
}

function _bruteForceBestResponse(root, store, brPlayer, keys, actionCounts, totalCombinations) {
  let bestValue = -Infinity;

  for (let combo = 0; combo < totalCombinations; combo++) {
    // Decode combo index into action assignment per info set
    const actionMap = new Map();
    let rem = combo;
    for (let i = keys.length - 1; i >= 0; i--) {
      actionMap.set(keys[i], rem % actionCounts[i]);
      rem = Math.floor(rem / actionCounts[i]);
    }

    const value = _evalPureStrategy(root, store, brPlayer, actionMap);
    if (value > bestValue) bestValue = value;
  }

  return bestValue;
}

function _evalPureStrategy(node, store, brPlayer, actionMap) {
  if (node.type === 'terminal') return node.payoffs[brPlayer];

  if (node.type === 'chance') {
    let ev = 0;
    for (const outcome of node.outcomes) {
      ev += outcome.prob * _evalPureStrategy(outcome.node, store, brPlayer, actionMap);
    }
    return ev;
  }

  const player = node.player;
  const numActions = node.actions.length;
  const infoKey = node.infoSetKey;

  if (player === brPlayer) {
    const chosenAction = actionMap.get(infoKey);
    const child = node.children[node.actions[chosenAction]];
    return _evalPureStrategy(child, store, brPlayer, actionMap);
  } else {
    const avgStrategy = store.getAverageStrategy(infoKey, numActions);
    let ev = 0;
    for (let a = 0; a < numActions; a++) {
      const child = node.children[node.actions[a]];
      ev += avgStrategy[a] * _evalPureStrategy(child, store, brPlayer, actionMap);
    }
    return ev;
  }
}

function _perNodeMax(node, store, brPlayer) {
  if (node.type === 'terminal') return node.payoffs[brPlayer];

  if (node.type === 'chance') {
    let ev = 0;
    for (const outcome of node.outcomes) {
      ev += outcome.prob * _perNodeMax(outcome.node, store, brPlayer);
    }
    return ev;
  }

  const player = node.player;
  const numActions = node.actions.length;
  const infoKey = node.infoSetKey;

  if (player === brPlayer) {
    let bestVal = -Infinity;
    for (let a = 0; a < numActions; a++) {
      const child = node.children[node.actions[a]];
      const v = _perNodeMax(child, store, brPlayer);
      if (v > bestVal) bestVal = v;
    }
    return bestVal;
  } else {
    const avgStrategy = store.getAverageStrategy(infoKey, numActions);
    let ev = 0;
    for (let a = 0; a < numActions; a++) {
      const child = node.children[node.actions[a]];
      ev += avgStrategy[a] * _perNodeMax(child, store, brPlayer);
    }
    return ev;
  }
}

/**
 * Compute total exploitability: sum of both players' best-response values.
 * At Nash equilibrium, exploitability = 0.
 *
 * @param {GameNode} root
 * @param {InfoSetStore} store
 * @returns {number} exploitability (>= 0, lower is better)
 */
export function computeExploitability(root, store) {
  const br0 = bestResponseValue(root, store, 0);
  const br1 = bestResponseValue(root, store, 1);
  return br0 + br1;
}

export default {
  InfoSetStore,
  cfrTraverse,
  solveGame,
  computeGameValue,
  bestResponseValue,
  computeExploitability,
};
