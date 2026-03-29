import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");

async function main() {
  const { evaluatePipeline } = await import("../lib/multimodal/eval");

  const modelId = process.argv[2] || undefined;

  console.log("Running pipeline evaluation...");
  if (modelId) {
    console.log(`Model ID: ${modelId}`);
  }

  const metrics = await evaluatePipeline(modelId);

  console.log("\n=== Evaluation Results ===\n");
  console.log(`Samples:    ${metrics.sample_count}`);
  console.log(`Accuracy:   ${(metrics.accuracy * 100).toFixed(1)}%`);
  console.log(`Precision:  ${(metrics.precision * 100).toFixed(1)}%`);
  console.log(`Recall:     ${(metrics.recall * 100).toFixed(1)}%`);
  console.log(`F1 Score:   ${(metrics.f1 * 100).toFixed(1)}%`);
  console.log(`ECE:        ${(metrics.ece * 100).toFixed(2)}%`);
  console.log(`MCE:        ${(metrics.mce * 100).toFixed(2)}%`);

  if (Object.keys(metrics.per_field).length > 0) {
    console.log("\n--- Per Field ---");
    for (const [field, m] of Object.entries(metrics.per_field)) {
      console.log(`  ${field.padEnd(18)} acc=${(m.accuracy * 100).toFixed(1)}%  f1=${(m.f1 * 100).toFixed(1)}%  ece=${(m.ece * 100).toFixed(2)}%  n=${m.count}`);
    }
  }

  if (Object.keys(metrics.per_source).length > 0) {
    console.log("\n--- Per Source ---");
    for (const [source, m] of Object.entries(metrics.per_source)) {
      console.log(`  ${source.padEnd(18)} acc=${(m.accuracy * 100).toFixed(1)}%  f1=${(m.f1 * 100).toFixed(1)}%  ece=${(m.ece * 100).toFixed(2)}%  n=${m.count}`);
    }
  }

  if (metrics.calibration_bins.length > 0) {
    console.log("\n--- Calibration Bins ---");
    console.log("  Bin Range      | Avg Conf | Avg Acc | Count");
    console.log("  " + "-".repeat(50));
    for (const bin of metrics.calibration_bins) {
      if (bin.count === 0) continue;
      console.log(
        `  [${bin.bin_start.toFixed(1)}, ${bin.bin_end.toFixed(1)}) | ${(bin.avg_confidence * 100).toFixed(1).padStart(6)}% | ${(bin.avg_accuracy * 100).toFixed(1).padStart(5)}% | ${bin.count}`,
      );
    }
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
