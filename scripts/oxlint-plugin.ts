import { definePlugin, defineRule } from "@oxlint/plugins";

function reportRelativeJsSpecifier(context: any, literal: any) {
  if (!literal || literal.type !== "Literal" || typeof literal.value !== "string") return;
  if (!/^\.{1,2}\/.*\.js$/.test(literal.value)) return;

  context.report({
    node: literal,
    messageId: "noRelativeJsImports",
  });
}

const noRelativeJsImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow relative .js imports in TypeScript source.",
    },
    messages: {
      noRelativeJsImports:
        "Use the real TypeScript source extension instead of a relative .js import.",
    },
  },
  createOnce(context) {
    return {
      ImportDeclaration(node) {
        reportRelativeJsSpecifier(context, node.source);
      },
      ExportAllDeclaration(node) {
        reportRelativeJsSpecifier(context, node.source);
      },
      ExportNamedDeclaration(node) {
        reportRelativeJsSpecifier(context, node.source);
      },
      ImportExpression(node) {
        reportRelativeJsSpecifier(context, node.source);
      },
      TSImportType(node) {
        reportRelativeJsSpecifier(context, node.source);
      },
    };
  },
});

export default definePlugin({
  meta: { name: "plakk" },
  rules: {
    "no-relative-js-imports": noRelativeJsImportsRule,
  },
});
