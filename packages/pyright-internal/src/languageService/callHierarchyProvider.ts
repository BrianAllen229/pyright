/*
 * callHierarchyProvider.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Logic that provides a list of callers or callees associated with
 * a position.
 */

import { CancellationToken, SymbolKind } from 'vscode-languageserver';
import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    Range,
} from 'vscode-languageserver-types';

import { Declaration, DeclarationType } from '../analyzer/declaration';
import * as DeclarationUtils from '../analyzer/declarationUtils';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { ParseTreeWalker } from '../analyzer/parseTreeWalker';
import { isUserCode } from '../analyzer/sourceFileInfoUtils';
import { SourceMapper } from '../analyzer/sourceMapper';
import { TypeEvaluator } from '../analyzer/typeEvaluatorTypes';
import { ClassMemberLookupFlags, doForEachSubtype, lookUpClassMember, lookUpObjectMember } from '../analyzer/typeUtils';
import { ClassType, isClassInstance, isFunction, isInstantiableClass } from '../analyzer/types';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { appendArray } from '../common/collectionUtils';
import { ProgramView } from '../common/extensibility';
import { getSymbolKind } from '../common/lspUtils';
import { convertPathToUri, getFileName } from '../common/pathUtils';
import { convertOffsetsToRange } from '../common/positionUtils';
import { Position, rangesAreEqual } from '../common/textRange';
import { ReferencesProvider, ReferencesResult } from '../languageService/referencesProvider';
import { CallNode, MemberAccessNode, NameNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import { ParseResults } from '../parser/parser';
import { DocumentSymbolCollector, DocumentSymbolCollectorUseCase } from './documentSymbolCollector';
import { canNavigateToFile } from './navigationUtils';

export class CallHierarchyProvider {
    private readonly _parseResults: ParseResults | undefined;
    private readonly _sourceMapper: SourceMapper;

    constructor(
        private _program: ProgramView,
        private _filePath: string,
        private _position: Position,
        private _token: CancellationToken
    ) {
        this._parseResults = this._program.getParseResults(this._filePath);
        this._sourceMapper = this._program.getSourceMapper(this._filePath, this._token);
    }

    onPrepare(): CallHierarchyItem[] | null {
        throwIfCancellationRequested(this._token);
        if (!this._parseResults) {
            return null;
        }

        const referencesResult = this._getDeclaration();
        if (!referencesResult || referencesResult.declarations.length === 0) {
            return null;
        }

        const { targetDecl, callItemUri, symbolName } = this._getTargetDeclaration(referencesResult);
        if (
            targetDecl.type !== DeclarationType.Function &&
            targetDecl.type !== DeclarationType.Class &&
            targetDecl.type !== DeclarationType.Alias
        ) {
            return null;
        }

        // make sure the alias is resolved to class or function
        if (targetDecl.type === DeclarationType.Alias) {
            const resolvedDecl = this._evaluator.resolveAliasDeclaration(targetDecl, true);
            if (!resolvedDecl) {
                return null;
            }

            if (resolvedDecl.type !== DeclarationType.Function && resolvedDecl.type !== DeclarationType.Class) {
                return null;
            }
        }

        const callItem: CallHierarchyItem = {
            name: symbolName,
            kind: getSymbolKind(targetDecl, this._evaluator, symbolName) ?? SymbolKind.Module,
            uri: callItemUri,
            range: targetDecl.range,
            selectionRange: targetDecl.range,
        };

        if (!canNavigateToFile(this._program.fileSystem, callItem.uri)) {
            return null;
        }

        // Convert the file path in the item to proper URI.
        callItem.uri = convertPathToUri(this._program.fileSystem, callItem.uri);

        return [callItem];
    }

    getIncomingCalls(): CallHierarchyIncomingCall[] | null {
        throwIfCancellationRequested(this._token);
        if (!this._parseResults) {
            return null;
        }

        const referencesResult = this._getDeclaration();
        if (!referencesResult || referencesResult.declarations.length === 0) {
            return null;
        }

        const { targetDecl, symbolName } = this._getTargetDeclaration(referencesResult);

        const items: CallHierarchyIncomingCall[] = [];
        const sourceFiles =
            targetDecl.type === DeclarationType.Alias
                ? [this._program.getSourceFileInfo(this._filePath)!]
                : this._program.getSourceFileInfoList();
        for (const curSourceFileInfo of sourceFiles) {
            if (isUserCode(curSourceFileInfo) || curSourceFileInfo.isOpenByClient) {
                const filePath = curSourceFileInfo.sourceFile.getFilePath();
                const itemsToAdd = this._getIncomingCallsForDeclaration(
                    this._program.getParseResults(filePath)!,
                    filePath,
                    symbolName,
                    targetDecl
                );

                if (itemsToAdd) {
                    appendArray(items, itemsToAdd);
                }

                // This operation can consume significant memory, so check
                // for situations where we need to discard the type cache.
                this._program.handleMemoryHighUsage();
            }
        }

        if (items.length === 0) {
            return null;
        }

        const callItems = items.filter((item) => canNavigateToFile(this._program.fileSystem, item.from.uri));

        // Convert the file paths in the items to proper URIs.
        callItems.forEach((item) => {
            item.from.uri = convertPathToUri(this._program.fileSystem, item.from.uri);
        });

        return callItems;
    }

    getOutgoingCalls(): CallHierarchyOutgoingCall[] | null {
        throwIfCancellationRequested(this._token);
        if (!this._parseResults) {
            return null;
        }

        const referencesResult = this._getDeclaration();
        if (!referencesResult || referencesResult.declarations.length === 0) {
            return null;
        }

        const { targetDecl } = this._getTargetDeclaration(referencesResult);

        // Find the parse node root corresponding to the function or class.
        let parseRoot: ParseNode | undefined;
        const resolvedDecl = this._evaluator.resolveAliasDeclaration(targetDecl, /* resolveLocalNames */ true);
        if (!resolvedDecl) {
            return null;
        }

        if (resolvedDecl.type === DeclarationType.Function) {
            parseRoot = resolvedDecl.node;
        } else if (resolvedDecl.type === DeclarationType.Class) {
            // Look up the __init__ method for this class.
            const classType = this._evaluator.getTypeForDeclaration(resolvedDecl)?.type;
            if (classType && isInstantiableClass(classType)) {
                // Don't perform a recursive search of parent classes in this
                // case because we don't want to find an inherited __init__
                // method defined in a different module.
                const initMethodMember = lookUpClassMember(
                    classType,
                    '__init__',
                    ClassMemberLookupFlags.SkipInstanceVariables |
                        ClassMemberLookupFlags.SkipObjectBaseClass |
                        ClassMemberLookupFlags.SkipBaseClasses
                );
                if (initMethodMember) {
                    const initMethodType = this._evaluator.getTypeOfMember(initMethodMember);
                    if (initMethodType && isFunction(initMethodType)) {
                        const initDecls = initMethodMember.symbol.getDeclarations();
                        if (initDecls && initDecls.length > 0) {
                            const primaryInitDecl = initDecls[0];
                            if (primaryInitDecl.type === DeclarationType.Function) {
                                parseRoot = primaryInitDecl.node;
                            }
                        }
                    }
                }
            }
        }

        if (!parseRoot) {
            return null;
        }

        const callFinder = new FindOutgoingCallTreeWalker(parseRoot, this._parseResults, this._evaluator, this._token);
        const outgoingCalls = callFinder.findCalls();
        if (outgoingCalls.length === 0) {
            return null;
        }

        const callItems = outgoingCalls.filter((item) => canNavigateToFile(this._program.fileSystem, item.to.uri));

        // Convert the file paths in the items to proper URIs.
        callItems.forEach((item) => {
            item.to.uri = convertPathToUri(this._program.fileSystem, item.to.uri);
        });

        return callItems;
    }

    private get _evaluator(): TypeEvaluator {
        return this._program.evaluator!;
    }

    private _getTargetDeclaration(referencesResult: ReferencesResult): {
        targetDecl: Declaration;
        callItemUri: string;
        symbolName: string;
    } {
        // If there's more than one declaration, pick the target one.
        // We'll always prefer one with a declared type, and we'll always
        // prefer later declarations.
        const declarations = referencesResult.declarations;
        const node = referencesResult.nodeAtOffset;
        let targetDecl = declarations[0];
        for (const decl of declarations) {
            if (DeclarationUtils.hasTypeForDeclaration(decl) || !DeclarationUtils.hasTypeForDeclaration(targetDecl)) {
                if (decl.type === DeclarationType.Function || decl.type === DeclarationType.Class) {
                    targetDecl = decl;

                    // If the specified node is an exact match, use this declaration
                    // as the primary even if it's not the last.
                    if (decl.node === node) {
                        break;
                    }
                }
            }
        }

        let symbolName;

        // Although the LSP specification requires a URI, we are using a file path
        // here because it is converted to the proper URI by the caller.
        // This simplifies our code and ensures compatibility with the LSP specification.
        let callItemUri;
        if (targetDecl.type === DeclarationType.Alias) {
            symbolName = (referencesResult.nodeAtOffset as NameNode).value;
            callItemUri = this._filePath;
        } else {
            symbolName = DeclarationUtils.getNameFromDeclaration(targetDecl) || referencesResult.symbolNames[0];
            callItemUri = targetDecl.path;
        }

        return { targetDecl, callItemUri, symbolName };
    }

    private _getIncomingCallsForDeclaration(
        parseResults: ParseResults,
        filePath: string,
        symbolName: string,
        declaration: Declaration
    ): CallHierarchyIncomingCall[] | undefined {
        throwIfCancellationRequested(this._token);

        const callFinder = new FindIncomingCallTreeWalker(
            filePath,
            symbolName,
            declaration,
            parseResults,
            this._evaluator,
            this._token,
            this._program
        );

        const incomingCalls = callFinder.findCalls();
        return incomingCalls.length > 0 ? incomingCalls : undefined;
    }

    private _getDeclaration(): ReferencesResult | undefined {
        return ReferencesProvider.getDeclarationForPosition(
            this._program,
            this._filePath,
            this._position,
            /* reporter */ undefined,
            DocumentSymbolCollectorUseCase.Reference,
            this._token
        );
    }
}

class FindOutgoingCallTreeWalker extends ParseTreeWalker {
    private _outgoingCalls: CallHierarchyOutgoingCall[] = [];

    constructor(
        private _parseRoot: ParseNode,
        private _parseResults: ParseResults,
        private _evaluator: TypeEvaluator,
        private _cancellationToken: CancellationToken
    ) {
        super();
    }

    findCalls(): CallHierarchyOutgoingCall[] {
        this.walk(this._parseRoot);
        return this._outgoingCalls;
    }

    override visitCall(node: CallNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        let nameNode: NameNode | undefined;

        if (node.leftExpression.nodeType === ParseNodeType.Name) {
            nameNode = node.leftExpression;
        } else if (node.leftExpression.nodeType === ParseNodeType.MemberAccess) {
            nameNode = node.leftExpression.memberName;
        }

        if (nameNode) {
            const declarations = this._evaluator.getDeclarationsForNameNode(nameNode);

            if (declarations) {
                // TODO - it would be better if we could match the call to the
                // specific declaration (e.g. a specific overload of a property
                // setter vs getter). For now, add callees for all declarations.
                declarations.forEach((decl) => {
                    this._addOutgoingCallForDeclaration(nameNode!, decl);
                });
            }
        }

        return true;
    }

    override visitMemberAccess(node: MemberAccessNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        // Determine whether the member corresponds to a property.
        // If so, we'll treat it as a function call for purposes of
        // finding outgoing calls.
        const leftHandType = this._evaluator.getType(node.leftExpression);
        if (leftHandType) {
            doForEachSubtype(leftHandType, (subtype) => {
                let baseType = subtype;

                // This could be a bound TypeVar (e.g. used for "self" and "cls").
                baseType = this._evaluator.makeTopLevelTypeVarsConcrete(baseType);

                if (!isClassInstance(baseType)) {
                    return;
                }

                const memberInfo = lookUpObjectMember(baseType, node.memberName.value);
                if (!memberInfo) {
                    return;
                }

                const memberType = this._evaluator.getTypeOfMember(memberInfo);
                const propertyDecls = memberInfo.symbol.getDeclarations();

                if (!memberType) {
                    return;
                }

                if (isClassInstance(memberType) && ClassType.isPropertyClass(memberType)) {
                    propertyDecls.forEach((decl) => {
                        this._addOutgoingCallForDeclaration(node.memberName, decl);
                    });
                }
            });
        }

        return true;
    }

    private _addOutgoingCallForDeclaration(nameNode: NameNode, declaration: Declaration) {
        const resolvedDecl = this._evaluator.resolveAliasDeclaration(declaration, /* resolveLocalNames */ true);
        if (!resolvedDecl) {
            return;
        }

        if (resolvedDecl.type !== DeclarationType.Function && resolvedDecl.type !== DeclarationType.Class) {
            return;
        }

        const callDest: CallHierarchyItem = {
            name: nameNode.value,
            kind: getSymbolKind(resolvedDecl, this._evaluator, nameNode.value) ?? SymbolKind.Module,
            uri: resolvedDecl.path,
            range: resolvedDecl.range,
            selectionRange: resolvedDecl.range,
        };

        // Is there already a call recorded for this destination? If so,
        // we'll simply add a new range. Otherwise, we'll create a new entry.
        let outgoingCall: CallHierarchyOutgoingCall | undefined = this._outgoingCalls.find(
            (outgoing) => outgoing.to.uri === callDest.uri && rangesAreEqual(outgoing.to.range, callDest.range)
        );

        if (!outgoingCall) {
            outgoingCall = {
                to: callDest,
                fromRanges: [],
            };
            this._outgoingCalls.push(outgoingCall);
        }

        if (outgoingCall && outgoingCall.to.name !== nameNode.value) {
            // If both the function and its alias are called in the same function,
            // the name of the call item will be the resolved declaration name, not the alias.
            outgoingCall.to.name = DeclarationUtils.getNameFromDeclaration(resolvedDecl) ?? nameNode.value;
        }

        const fromRange: Range = convertOffsetsToRange(
            nameNode.start,
            nameNode.start + nameNode.length,
            this._parseResults.tokenizerOutput.lines
        );
        outgoingCall.fromRanges.push(fromRange);
    }
}

class FindIncomingCallTreeWalker extends ParseTreeWalker {
    private _incomingCalls: CallHierarchyIncomingCall[] = [];

    constructor(
        private _filePath: string,
        private _symbolName: string,
        private _declaration: Declaration,
        private _parseResults: ParseResults,
        private _evaluator: TypeEvaluator,
        private _cancellationToken: CancellationToken,
        private _program: ProgramView
    ) {
        super();
    }

    findCalls(): CallHierarchyIncomingCall[] {
        this.walk(this._parseResults.parseTree);
        return this._incomingCalls;
    }

    override visitCall(node: CallNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        let nameNode: NameNode | undefined;

        if (node.leftExpression.nodeType === ParseNodeType.Name) {
            nameNode = node.leftExpression;
        } else if (node.leftExpression.nodeType === ParseNodeType.MemberAccess) {
            nameNode = node.leftExpression.memberName;
        }

        // Don't bother doing any more work if the name doesn't match.
        if (nameNode && nameNode.value === this._symbolName) {
            const declarations = DocumentSymbolCollector.getDeclarationsForNode(
                this._program,
                nameNode,
                /* resolveLocalName */ true,
                DocumentSymbolCollectorUseCase.Reference,
                this._cancellationToken
            );

            if (declarations) {
                if (this._declaration.type === DeclarationType.Alias) {
                    const resolvedCurDecls = this._evaluator.resolveAliasDeclaration(
                        this._declaration,
                        /* resolveLocalNames */ true
                    );
                    if (
                        resolvedCurDecls &&
                        declarations.some((decl) => DeclarationUtils.areDeclarationsSame(decl!, resolvedCurDecls))
                    ) {
                        this._addIncomingCallForDeclaration(nameNode!);
                    }
                } else if (
                    declarations.some((decl) => DeclarationUtils.areDeclarationsSame(decl!, this._declaration))
                ) {
                    this._addIncomingCallForDeclaration(nameNode!);
                }
            }
        }

        return true;
    }

    override visitMemberAccess(node: MemberAccessNode): boolean {
        throwIfCancellationRequested(this._cancellationToken);

        if (node.memberName.value === this._symbolName) {
            // Determine whether the member corresponds to a property.
            // If so, we'll treat it as a function call for purposes of
            // finding outgoing calls.
            const leftHandType = this._evaluator.getType(node.leftExpression);
            if (leftHandType) {
                doForEachSubtype(leftHandType, (subtype) => {
                    let baseType = subtype;

                    // This could be a bound TypeVar (e.g. used for "self" and "cls").
                    baseType = this._evaluator.makeTopLevelTypeVarsConcrete(baseType);

                    if (!isClassInstance(baseType)) {
                        return;
                    }

                    const memberInfo = lookUpObjectMember(baseType, node.memberName.value);
                    if (!memberInfo) {
                        return;
                    }

                    const memberType = this._evaluator.getTypeOfMember(memberInfo);
                    const propertyDecls = memberInfo.symbol.getDeclarations();

                    if (!memberType) {
                        return;
                    }

                    if (propertyDecls.some((decl) => DeclarationUtils.areDeclarationsSame(decl!, this._declaration))) {
                        this._addIncomingCallForDeclaration(node.memberName);
                    }
                });
            }
        }

        return true;
    }

    private _addIncomingCallForDeclaration(nameNode: NameNode) {
        const executionNode = ParseTreeUtils.getExecutionScopeNode(nameNode);
        if (!executionNode) {
            return;
        }

        let callSource: CallHierarchyItem;
        if (executionNode.nodeType === ParseNodeType.Module) {
            const moduleRange = convertOffsetsToRange(0, 0, this._parseResults.tokenizerOutput.lines);
            const fileName = getFileName(this._filePath);

            callSource = {
                name: `(module) ${fileName}`,
                kind: SymbolKind.Module,
                uri: this._filePath,
                range: moduleRange,
                selectionRange: moduleRange,
            };
        } else if (executionNode.nodeType === ParseNodeType.Lambda) {
            const lambdaRange = convertOffsetsToRange(
                executionNode.start,
                executionNode.start + executionNode.length,
                this._parseResults.tokenizerOutput.lines
            );

            callSource = {
                name: '(lambda)',
                kind: SymbolKind.Function,
                uri: this._filePath,
                range: lambdaRange,
                selectionRange: lambdaRange,
            };
        } else {
            const functionRange = convertOffsetsToRange(
                executionNode.name.start,
                executionNode.name.start + executionNode.name.length,
                this._parseResults.tokenizerOutput.lines
            );

            callSource = {
                name: executionNode.name.value,
                kind: SymbolKind.Function,
                uri: this._filePath,
                range: functionRange,
                selectionRange: functionRange,
            };
        }

        // Is there already a call recorded for this caller? If so,
        // we'll simply add a new range. Otherwise, we'll create a new entry.
        let incomingCall: CallHierarchyIncomingCall | undefined = this._incomingCalls.find(
            (incoming) => incoming.from.uri === callSource.uri && rangesAreEqual(incoming.from.range, callSource.range)
        );

        if (!incomingCall) {
            incomingCall = {
                from: callSource,
                fromRanges: [],
            };
            this._incomingCalls.push(incomingCall);
        }

        const fromRange: Range = convertOffsetsToRange(
            nameNode.start,
            nameNode.start + nameNode.length,
            this._parseResults.tokenizerOutput.lines
        );
        incomingCall.fromRanges.push(fromRange);
    }
}
