/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  CompletionItem,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  InitializeParams,
  InitializeResult,
  Position,
  ProposedFeatures,
  TextDocumentPositionParams,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";

import fs = require("fs");
import tmp = require("tmp");

import util = require("node:util");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const exec = util.promisify(require("node:child_process").exec);

const tmpFile = tmp.fileSync();
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: false,
      },

      documentFormattingProvider: true,
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: false,
      },
    };
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined,
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log("Workspace folder change event received.");
    });
  }
});

function getRange(stdout: string): [Position, Position] {
  const se = (stdout.match(/\[\d+:\d+\]/g))?.map((e) =>
    e.replace(/[[\]]/g, "")
  );
  //   console.log(se);
  let start: Position = <Position> { line: 0, character: 0 };
  let end = null;
  if (!se) {
    return [start, end ?? start];
  }
  if (se) {
    start = <Position> {
      line: parseInt(se![0].split(":")[0]) - 1,
      character: parseInt(se![0].split(":")[1]) - 1,
    };
  }
  if (se?.length == 2) {
    end = <Position> {
      line: parseInt(se![1].split(":")[0]) - 1,
      character: parseInt(se![1].split(":")[1]) - 1,
    };
  }
  //   console.log(start, end);
  return [start, end ?? start];
}

async function runCompiler(
  text: string,
  flags: string,
  settings: ExampleSettings,
): Promise<string> {
  try {
    fs.writeFileSync(tmpFile.name, text);
  } catch (e: any) {
    connection.console.log(e);
  }

  let stdout: string;
  try {
    console.log(settings.executablePath);
    const output = await exec(
      `${settings.executablePath} ${flags} ${tmpFile.name}`,
      {
        timeout: settings.maxCompilerInvocationTime,
      },
    );
    stdout = output.stdout;
  } catch (e: any) {
    stdout = e.stderr;
  }
  stdout = stdout.slice(0, stdout.length - 2);
  console.log(stdout);
  return stdout;
}

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
  executablePath: string;
  maxCompilerInvocationTime: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = {
  maxNumberOfProblems: 1000,
  executablePath: "ash_lang_cli",
  maxCompilerInvocationTime: 5000,
};
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings> (
      change.settings.languageServerExample || defaultSettings
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "ashlangServer",
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  // In this simple example we get the settings for every validate run.
  const settings = await getDocumentSettings(textDocument.uri);

  // The validator creates diagnostics for all uppercase words length 2 and more
  const text = textDocument.getText();
  const stdout = await runCompiler(text, "analyze", settings);
  const diagnostics: Diagnostic[] = [];

  if (stdout.trim() !== "") {
    const parts = stdout.split(":");
    const range = getRange(stdout);
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Error,
      range: {
        start: range[0],
        end: range[1],
      },
      message: parts[parts.length - 1],
      source: "ashlang",
    };
    diagnostics.push(diagnostic);
  }

  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log("We received an file change event");
});

connection.onDocumentFormatting(async (params) => {
  console.time("onDocumentFormatting Rust");
  const document = documents.get(params.textDocument.uri);
  const settings = await getDocumentSettings(params.textDocument.uri);

  const text = document?.getText();

  if (typeof text == "string" && text.trim() != "") {
    const formatted = await runCompiler(
      text,
      "fmt",
      settings,
    );
    if (formatted.trim() != "") {
      console.timeEnd("onDocumentFormatting Rust");
      return [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: document!.lineCount, character: 0 },
          },
          newText: formatted,
        },
      ];
    }
  }
  console.timeEnd("onDocumentFormatting Rust");
  return [];
});
// // This handler provides the initial list of the completion items.
connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [];
  },
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
      item.detail = "TypeScript details";
      item.documentation = "TypeScript documentation";
    } else if (item.data === 2) {
      item.detail = "JavaScript details";
      item.documentation = "JavaScript documentation";
    }
    return item;
  },
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
