import {
	type Expression,
	Node,
	Project,
	ScriptKind,
	SyntaxKind,
	ts,
	type VariableStatement,
} from "ts-morph";

export type StaticToolEnvVar = {
	description?: string;
	options: string[][];
};

export type StaticToolEnvVars = StaticToolEnvVar[];

export type StaticToolMetadata = {
	toolEnvVars: StaticToolEnvVars;
};

function isExportedConst(node: VariableStatement): boolean {
	return node.isExported();
}

function unwrapExpression(node: Expression): Expression {
	if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
		return unwrapExpression(node.getExpression());
	}
	return node;
}

function readString(node: Expression): string | null {
	const expr = unwrapExpression(node);
	if (
		Node.isStringLiteral(expr) ||
		expr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
	) {
		return expr.getText().replace(/^['"`]|['"`]$/g, "");
	}
	return null;
}

function readStringArray(node: Expression): string[] | null {
	const expr = unwrapExpression(node);
	if (!Node.isArrayLiteralExpression(expr)) {
		return null;
	}

	const values: string[] = [];
	for (const element of expr.getElements()) {
		if (!Node.isExpression(element)) return null;
		const value = readString(element);
		if (value === null) return null;
		values.push(value);
	}

	return values;
}

function readToolEnvVar(node: Expression): StaticToolEnvVar | null {
	const expr = unwrapExpression(node);
	if (!Node.isObjectLiteralExpression(expr)) {
		return null;
	}

	let description: string | null = null;
	let options: string[][] | null = null;

	for (const property of expr.getProperties()) {
		if (!Node.isPropertyAssignment(property)) {
			return null;
		}

		const nameNode = property.getNameNode();
		const name =
			Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode)
				? nameNode.getText().replace(/^['"]|['"]$/g, "")
				: null;

		if (name === "description") {
			description = readString(property.getInitializerOrThrow());
		} else if (name === "options") {
			const outer = unwrapExpression(property.getInitializerOrThrow());
			if (!Node.isArrayLiteralExpression(outer)) {
				return null;
			}

			const groups: string[][] = [];
			for (const element of outer.getElements()) {
				if (!Node.isExpression(element)) return null;
				const group = readStringArray(element);
				if (group === null) return null;
				groups.push(group);
			}
			options = groups;
		}
	}

	return options ? { ...(description ? { description } : {}), options } : null;
}

function readToolEnvVars(node: Expression): StaticToolEnvVars {
	const expr = unwrapExpression(node);
	if (!Node.isArrayLiteralExpression(expr)) {
		return [];
	}

	const toolEnvVars: StaticToolEnvVars = [];
	for (const element of expr.getElements()) {
		if (!Node.isExpression(element)) return [];
		const toolEnvVar = readToolEnvVar(element);
		if (!toolEnvVar) return [];
		toolEnvVars.push(toolEnvVar);
	}

	return toolEnvVars;
}

export function readStaticToolMetadata(sourceText: string): StaticToolMetadata {
	const project = new Project({
		compilerOptions: {
			allowJs: false,
			target: ts.ScriptTarget.ESNext,
		},
		useInMemoryFileSystem: true,
	});
	const sourceFile = project.createSourceFile("tool.ts", sourceText, {
		overwrite: true,
		scriptKind: ScriptKind.TS,
	});

	const toolEnvVars: StaticToolEnvVars = [];

	sourceFile.forEachDescendant((node) => {
		if (Node.isVariableStatement(node) && isExportedConst(node)) {
			for (const declaration of node.getDeclarations()) {
				if (declaration.getName() === "toolEnvVars") {
					const initializer = declaration.getInitializer();
					if (initializer && Node.isExpression(initializer)) {
						toolEnvVars.push(...readToolEnvVars(initializer));
					}
				}
			}
		}
	});

	return {
		toolEnvVars,
	};
}
