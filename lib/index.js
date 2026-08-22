'use strict';

const { createSlackApp, DEFAULT_SCOPES } = require('./create-app');
const { createInstallationStore } = require('./installation-store');
const { createRegistrar } = require('./registrar');
const { createErrorHandler, SlackUserError } = require('./errors');
const { createOpsAlert } = require('./ops-alert');
const { createEngagementTracker, CoreEventType } = require('./engagement-tracker');
const { createFeatureAccess, AccessEventType } = require('./feature-access');
const { createUserLookup } = require('./user-lookup');
const { deliverFileToUser, deliverCsvExportToUser } = require('./file-delivery');
const {
  buildPlanBlock,
  createSteps,
  updateStepProgress,
  buildCompletionBlocks,
  STATUS_EMOJI,
} = require('./plan-block');
const {
  ackSafely,
  mapWithConcurrency,
  splitSlackTextChunks,
  isSlackNotFoundError,
  isDirectMessageEvent,
  normalizeMultilineNote,
  extractUserId,
} = require('./helpers');
const { normalizeLogger } = require('./logger');

module.exports = {
  // App bootstrap
  createSlackApp,
  DEFAULT_SCOPES,

  // OAuth installation store
  createInstallationStore,

  // Handler modules
  createRegistrar,

  // Error handling
  createErrorHandler,
  SlackUserError,

  // Ops alerts
  createOpsAlert,

  // Analytics
  createEngagementTracker,
  CoreEventType,

  // Feature gating
  createFeatureAccess,
  AccessEventType,

  // User lookup
  createUserLookup,

  // File delivery
  deliverFileToUser,
  deliverCsvExportToUser,

  // Progress blocks
  buildPlanBlock,
  createSteps,
  updateStepProgress,
  buildCompletionBlocks,
  STATUS_EMOJI,

  // Helpers
  ackSafely,
  mapWithConcurrency,
  splitSlackTextChunks,
  isSlackNotFoundError,
  isDirectMessageEvent,
  normalizeMultilineNote,
  extractUserId,
  normalizeLogger,
};
