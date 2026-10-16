const featureStageLabel = "dev_container_auto_added_stage_label";
const fromLinePattern = /^\s*FROM.*/gim;
const fromInstructionPattern = /FROM\s+(?:--platform=\S+\s+)?"?[^\s]+"?(?<label>\s+AS\s+[^\s]+)?/i;
const leadingSyntaxDirectivePattern = /^\s*#\s*syntax\s*=.*[\r\n]/;

function labelFinalStage(containerfile: string): string {
  const finalFromLine = [...containerfile.matchAll(fromLinePattern)].at(-1);
  if (!finalFromLine) {
    return containerfile;
  }
  const instruction = fromInstructionPattern.exec(finalFromLine[0]);
  const finalStageIsLabeled = Boolean(instruction?.groups?.label);
  if (!instruction || finalStageIsLabeled) {
    return containerfile;
  }
  const instructionEnd = finalFromLine.index + instruction.index + instruction[0].length;
  return `${containerfile.slice(0, instructionEnd)} AS ${featureStageLabel}${containerfile.slice(instructionEnd)}`;
}

export function embeddedFeatureRecipeBase(containerfile: string, buildTarget?: string): string {
  const stagedContainerfile = buildTarget ? containerfile : labelFinalStage(containerfile);
  return stagedContainerfile.replace(leadingSyntaxDirectivePattern, "");
}

export function isGeneratedFeatureRecipe(
  generated: string,
  original: string,
  buildTarget?: string,
): boolean {
  return generated.includes(embeddedFeatureRecipeBase(original, buildTarget));
}
