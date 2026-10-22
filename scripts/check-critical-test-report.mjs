import { readFileSync } from "node:fs";

// 报告缺失、测试未完成或跳过用例都不能通过关键测试门禁。
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (
  report.success !== true ||
  !Number.isInteger(report.numTotalTests) ||
  report.numTotalTests <= 0 ||
  report.numPassedTests !== report.numTotalTests ||
  report.numFailedTests !== 0 ||
  report.numPendingTests !== 0 ||
  report.numTodoTests !== 0 ||
  !Array.isArray(report.testResults) ||
  report.testResults.length === 0 ||
  report.testResults.some(
    (file) =>
      file.status !== "passed" ||
      file.assertionResults.length === 0 ||
      file.assertionResults.some((test) => test.status !== "passed"),
  )
) {
  throw new Error(
    "Critical tests must finish with every test passed and zero skips",
  );
}

console.log(`Critical tests: ${report.numPassedTests} passed, zero skips`);
for (const file of report.testResults) {
  console.log(
    `${((file.endTime - file.startTime) / 1000).toFixed(1)}s ${file.name}`,
  );
}
