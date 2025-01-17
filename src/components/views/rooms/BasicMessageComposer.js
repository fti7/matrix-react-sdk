/*
Copyright 2019 New Vector Ltd
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import classNames from 'classnames';
import React from 'react';
import PropTypes from 'prop-types';
import EditorModel from '../../../editor/model';
import HistoryManager from '../../../editor/history';
import {setCaretPosition} from '../../../editor/caret';
import {getCaretOffsetAndText} from '../../../editor/dom';
import Autocomplete from '../rooms/Autocomplete';
import {autoCompleteCreator} from '../../../editor/parts';
import {renderModel} from '../../../editor/render';
import {Room} from 'matrix-js-sdk';
import TypingStore from "../../../stores/TypingStore";
import EMOJIBASE from 'emojibase-data/en/compact.json';
import SettingsStore from "../../../settings/SettingsStore";
import EMOTICON_REGEX from 'emojibase-regex/emoticon';

const REGEX_EMOTICON_WHITESPACE = new RegExp('(?:^|\\s)(' + EMOTICON_REGEX.source + ')\\s$');

const IS_MAC = navigator.platform.indexOf("Mac") !== -1;

function cloneSelection(selection) {
    return {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
        isCollapsed: selection.isCollapsed,
        rangeCount: selection.rangeCount,
        type: selection.type,
    };
}

function selectionEquals(a: Selection, b: Selection): boolean {
    return a.anchorNode === b.anchorNode &&
        a.anchorOffset === b.anchorOffset &&
        a.focusNode === b.focusNode &&
        a.focusOffset === b.focusOffset &&
        a.isCollapsed === b.isCollapsed &&
        a.rangeCount === b.rangeCount &&
        a.type === b.type;
}

export default class BasicMessageEditor extends React.Component {
    static propTypes = {
        onChange: PropTypes.func,
        model: PropTypes.instanceOf(EditorModel).isRequired,
        room: PropTypes.instanceOf(Room).isRequired,
        placeholder: PropTypes.string,
        label: PropTypes.string,    // the aria label
        initialCaret: PropTypes.object, // See DocumentPosition in editor/model.js
    };

    constructor(props, context) {
        super(props, context);
        this.state = {
            autoComplete: null,
        };
        this._editorRef = null;
        this._autocompleteRef = null;
        this._modifiedFlag = false;
        this._isIMEComposing = false;
    }

    _replaceEmoticon = (caretPosition, inputType, diff) => {
        const {model} = this.props;
        const range = model.startRange(caretPosition);
        // expand range max 8 characters backwards from caretPosition,
        // as a space to look for an emoticon
        let n = 8;
        range.expandBackwardsWhile((index, offset) => {
            const part = model.parts[index];
            n -= 1;
            return n >= 0 && (part.type === "plain" || part.type === "pill-candidate");
        });
        const emoticonMatch = REGEX_EMOTICON_WHITESPACE.exec(range.text);
        if (emoticonMatch) {
            const query = emoticonMatch[1].toLowerCase().replace("-", "");
            const data = EMOJIBASE.find(e => e.emoticon ? e.emoticon.toLowerCase() === query : false);
            if (data) {
                const {partCreator} = model;
                const hasPrecedingSpace = emoticonMatch[0][0] === " ";
                // we need the range to only comprise of the emoticon
                // because we'll replace the whole range with an emoji,
                // so move the start forward to the start of the emoticon.
                // Take + 1 because index is reported without the possible preceding space.
                range.moveStart(emoticonMatch.index + (hasPrecedingSpace ? 1 : 0));
                // this returns the amount of added/removed characters during the replace
                // so the caret position can be adjusted.
                return range.replace([partCreator.plain(data.unicode + " ")]);
            }
        }
    }

    _updateEditorState = (caret, inputType, diff) => {
        renderModel(this._editorRef, this.props.model);
        if (caret) {
            try {
                setCaretPosition(this._editorRef, this.props.model, caret);
            } catch (err) {
                console.error(err);
            }
        }
        if (this.props.placeholder) {
            const {isEmpty} = this.props.model;
            if (isEmpty) {
                this._showPlaceholder();
            } else {
                this._hidePlaceholder();
            }
        }
        this.setState({autoComplete: this.props.model.autoComplete});
        this.historyManager.tryPush(this.props.model, caret, inputType, diff);
        TypingStore.sharedInstance().setSelfTyping(this.props.room.roomId, !this.props.model.isEmpty);

        if (this.props.onChange) {
            this.props.onChange();
        }
    }

    _showPlaceholder() {
        this._editorRef.style.setProperty("--placeholder", `'${this.props.placeholder}'`);
        this._editorRef.classList.add("mx_BasicMessageComposer_inputEmpty");
    }

    _hidePlaceholder() {
        this._editorRef.classList.remove("mx_BasicMessageComposer_inputEmpty");
        this._editorRef.style.removeProperty("--placeholder");
    }

    _onCompositionStart = (event) => {
        this._isIMEComposing = true;
        // even if the model is empty, the composition text shouldn't be mixed with the placeholder
        this._hidePlaceholder();
    }

    _onCompositionEnd = (event) => {
        this._isIMEComposing = false;
        // some browsers (chromium) don't fire an input event after ending a composition
        // so trigger a model update after the composition is done by calling the input handler
        this._onInput({inputType: "insertCompositionText"});
    }

    _onInput = (event) => {
        // ignore any input while doing IME compositions
        if (this._isIMEComposing) {
            return;
        }
        this._modifiedFlag = true;
        const sel = document.getSelection();
        const {caret, text} = getCaretOffsetAndText(this._editorRef, sel);
        this._setLastCaret(caret, text, sel);
        this.props.model.update(text, event.inputType, caret);
    }

    _insertText(textToInsert, inputType = "insertText") {
        const sel = document.getSelection();
        const {caret, text} = getCaretOffsetAndText(this._editorRef, sel);
        const newText = text.substr(0, caret.offset) + textToInsert + text.substr(caret.offset);
        caret.offset += textToInsert.length;
        this.props.model.update(newText, inputType, caret);
    }

    // this is used later to see if we need to recalculate the caret
    // on selectionchange. If it is just a consequence of typing
    // we don't need to. But if the user is navigating the caret without input
    // we need to recalculate it, to be able to know where to insert content after
    // losing focus
    _setLastCaret(caret, text, selection) {
        this._lastSelection = cloneSelection(selection);
        this._lastCaret = caret;
        this._lastTextLength = text.length;
    }

    _refreshLastCaretIfNeeded() {
        // XXX: needed when going up and down in editing messages ... not sure why yet
        // because the editors should stop doing this when when blurred ...
        // maybe it's on focus and the _editorRef isn't available yet or something.
        if (!this._editorRef) {
            return;
        }
        const selection = document.getSelection();
        if (!this._lastSelection || !selectionEquals(this._lastSelection, selection)) {
            this._lastSelection = cloneSelection(selection);
            const {caret, text} = getCaretOffsetAndText(this._editorRef, selection);
            this._lastCaret = caret;
            this._lastTextLength = text.length;
        }
        return this._lastCaret;
    }

    clearUndoHistory() {
        this.historyManager.clear();
    }

    getCaret() {
        return this._lastCaret;
    }

    isSelectionCollapsed() {
        return !this._lastSelection || this._lastSelection.isCollapsed;
    }

    isCaretAtStart() {
        return this.getCaret().offset === 0;
    }

    isCaretAtEnd() {
        return this.getCaret().offset === this._lastTextLength;
    }

    _onBlur = () => {
        document.removeEventListener("selectionchange", this._onSelectionChange);
    }

    _onFocus = () => {
        document.addEventListener("selectionchange", this._onSelectionChange);
        // force to recalculate
        this._lastSelection = null;
        this._refreshLastCaretIfNeeded();
    }

    _onSelectionChange = () => {
        this._refreshLastCaretIfNeeded();
    }

    _onKeyDown = (event) => {
        const model = this.props.model;
        const modKey = IS_MAC ? event.metaKey : event.ctrlKey;
        let handled = false;
        // undo
        if (modKey && event.key === "z") {
            if (this.historyManager.canUndo()) {
                const {parts, caret} = this.historyManager.undo(this.props.model);
                // pass matching inputType so historyManager doesn't push echo
                // when invoked from rerender callback.
                model.reset(parts, caret, "historyUndo");
            }
            handled = true;
        // redo
        } else if (modKey && event.key === "y") {
            if (this.historyManager.canRedo()) {
                const {parts, caret} = this.historyManager.redo();
                // pass matching inputType so historyManager doesn't push echo
                // when invoked from rerender callback.
                model.reset(parts, caret, "historyRedo");
            }
            handled = true;
        // insert newline on Shift+Enter
        } else if (event.key === "Enter" && (event.shiftKey || (IS_MAC && event.altKey))) {
            this._insertText("\n");
            handled = true;
        // autocomplete or enter to send below shouldn't have any modifier keys pressed.
        } else if (!(event.metaKey || event.altKey || event.shiftKey)) {
            if (model.autoComplete) {
                const autoComplete = model.autoComplete;
                switch (event.key) {
                    case "ArrowUp":
                        autoComplete.onUpArrow(event);
                        handled = true;
                        break;
                    case "ArrowDown":
                        autoComplete.onDownArrow(event);
                        handled = true;
                        break;
                    case "Tab":
                        autoComplete.onTab(event);
                        handled = true;
                        break;
                    case "Escape":
                        autoComplete.onEscape(event);
                        handled = true;
                        break;
                    default:
                        return; // don't preventDefault on anything else
                }
            } else if (event.key === "Tab") {
                this._tabCompleteName();
                handled = true;
            }
        }
        if (handled) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    async _tabCompleteName() {
        try {
            await new Promise(resolve => this.setState({showVisualBell: false}, resolve));
            const {model} = this.props;
            const caret = this.getCaret();
            const position = model.positionForOffset(caret.offset, caret.atNodeEnd);
            const range = model.startRange(position);
            range.expandBackwardsWhile((index, offset, part) => {
                return part.text[offset] !== " " && (part.type === "plain" || part.type === "pill-candidate");
            });
            const {partCreator} = model;
            // await for auto-complete to be open
            await model.transform(() => {
                const addedLen = range.replace([partCreator.pillCandidate(range.text)]);
                return model.positionForOffset(caret.offset + addedLen, true);
            });
            await model.autoComplete.onTab();
            if (!model.autoComplete.hasSelection()) {
                this.setState({showVisualBell: true});
                model.autoComplete.close();
            }
        } catch (err) {
            console.error(err);
        }
    }

    getEditableRootNode() {
        return this._editorRef;
    }

    isModified() {
        return this._modifiedFlag;
    }

    _onAutoCompleteConfirm = (completion) => {
        this.props.model.autoComplete.onComponentConfirm(completion);
    }

    _onAutoCompleteSelectionChange = (completion) => {
        this.props.model.autoComplete.onComponentSelectionChange(completion);
    }

    componentWillUnmount() {
        this._editorRef.removeEventListener("input", this._onInput, true);
        this._editorRef.removeEventListener("compositionstart", this._onCompositionStart, true);
        this._editorRef.removeEventListener("compositionend", this._onCompositionEnd, true);
    }

    componentDidMount() {
        const model = this.props.model;
        model.setUpdateCallback(this._updateEditorState);
        if (SettingsStore.getValue('MessageComposerInput.autoReplaceEmoji')) {
            model.setTransformCallback(this._replaceEmoticon);
        }
        const partCreator = model.partCreator;
        // TODO: does this allow us to get rid of EditorStateTransfer?
        // not really, but we could not serialize the parts, and just change the autoCompleter
        partCreator.setAutoCompleteCreator(autoCompleteCreator(
            () => this._autocompleteRef,
            query => new Promise(resolve => this.setState({query}, resolve)),
        ));
        this.historyManager = new HistoryManager(partCreator);
        // initial render of model
        this._updateEditorState(this._getInitialCaretPosition());
        // attach input listener by hand so React doesn't proxy the events,
        // as the proxied event doesn't support inputType, which we need.
        this._editorRef.addEventListener("input", this._onInput, true);
        this._editorRef.addEventListener("compositionstart", this._onCompositionStart, true);
        this._editorRef.addEventListener("compositionend", this._onCompositionEnd, true);
        this._editorRef.focus();
    }

    _getInitialCaretPosition() {
        let caretPosition;
        if (this.props.initialCaret) {
            // if restoring state from a previous editor,
            // restore caret position from the state
            const caret = this.props.initialCaret;
            caretPosition = this.props.model.positionForOffset(caret.offset, caret.atNodeEnd);
        } else {
            // otherwise, set it at the end
            caretPosition = this.props.model.getPositionAtEnd();
        }
        return caretPosition;
    }

    render() {
        let autoComplete;
        if (this.state.autoComplete) {
            const query = this.state.query;
            const queryLen = query.length;
            autoComplete = (<div className="mx_BasicMessageComposer_AutoCompleteWrapper">
                <Autocomplete
                    ref={ref => this._autocompleteRef = ref}
                    query={query}
                    onConfirm={this._onAutoCompleteConfirm}
                    onSelectionChange={this._onAutoCompleteSelectionChange}
                    selection={{beginning: true, end: queryLen, start: queryLen}}
                    room={this.props.room}
                />
            </div>);
        }
        const classes = classNames("mx_BasicMessageComposer", {
            "mx_BasicMessageComposer_input_error": this.state.showVisualBell,
        });
        return (<div className={classes}>
            { autoComplete }
            <div
                className="mx_BasicMessageComposer_input"
                contentEditable="true"
                tabIndex="1"
                onBlur={this._onBlur}
                onFocus={this._onFocus}
                onKeyDown={this._onKeyDown}
                ref={ref => this._editorRef = ref}
                aria-label={this.props.label}
            ></div>
        </div>);
    }

    focus() {
        this._editorRef.focus();
    }
}
