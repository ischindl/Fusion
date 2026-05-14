import { useState, useCallback, useMemo, useRef, useId, type UIEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileEdit, Eye, ListOrdered, WrapText, ChevronDown, ChevronUp } from "lucide-react";

interface FileEditorProps {
  content: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  filePath?: string;
  showLineNumbers?: boolean;
  onToggleLineNumbers?: () => void;
  canToggleLineNumbers?: boolean;
}

function isMarkdownFile(filePath?: string): boolean {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown") || lowerPath.endsWith(".mdx");
}

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme !== "light";
}

export function FileEditor({
  content,
  onChange,
  readOnly,
  filePath,
  showLineNumbers = false,
  onToggleLineNumbers,
  canToggleLineNumbers = true,
}: FileEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const [toolbarActionsExpanded, setToolbarActionsExpanded] = useState(false);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const isMarkdown = isMarkdownFile(filePath);
  const toolbarActionsId = useId();

  // For markdown files in readOnly mode, default to preview
  const effectiveShowPreview = isMarkdown && (readOnly ? true : showPreview);
  const shouldRenderLineNumbers = showLineNumbers && !readOnly && !effectiveShowPreview;
  const shouldShowLineNumbersToggle = Boolean(onToggleLineNumbers) && canToggleLineNumbers && !readOnly && !effectiveShowPreview;
  const hasSecondaryActions = shouldShowLineNumbersToggle || !readOnly;
  const lineCount = useMemo(() => {
    if (!shouldRenderLineNumbers) {
      return 0;
    }

  const languageExtension = useMemo(() => resolveCodeMirrorLanguage(filePath), [filePath]);

  const handleEditClick = useCallback(() => {
    setShowPreview(false);
  }, []);

  const handlePreviewClick = useCallback(() => {
    setShowPreview(true);
  }, []);

  const handleWordWrapToggle = useCallback(() => {
    setWordWrap((prev) => !prev);
  }, []);

  const handleToolbarActionsToggle = useCallback(() => {
    setToolbarActionsExpanded((prev) => !prev);
  }, []);

  const handleTextareaScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    if (!lineNumbersRef.current) {
      return;
    }

    const themeOverlay = EditorView.theme({
      "&": {
        height: "100%",
        fontFamily: "var(--font-mono)",
        backgroundColor: "var(--bg)",
        color: "var(--text)",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        fontSize: "calc(var(--space-md) + var(--space-xs) * 0.5)",
      },
      ".cm-content": {
        caretColor: "var(--text)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--surface)",
        color: "var(--text-muted)",
        borderRight: "calc(var(--space-xs) * 0.25) solid var(--border)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--surface) 80%, transparent)",
      },
      ".cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "color-mix(in srgb, var(--todo) 30%, transparent)",
      },
      "&.cm-focused": {
        outline: "none",
      },
    });

    const lineNumbersExtension = shouldRenderLineNumbers ? lineNumbers() : [];
    const wrapExtension = wordWrap ? EditorView.lineWrapping : [];
    const readOnlyExtensions = readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
    const themeExtension = darkThemeActive ? [oneDark] : [];

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbersCompartmentRef.current.of(lineNumbersExtension),
        wordWrapCompartmentRef.current.of(wrapExtension),
        readOnlyCompartmentRef.current.of(readOnlyExtensions),
        languageCompartmentRef.current.of(languageExtension ?? []),
        themeCompartmentRef.current.of(themeExtension),
        themeOverlay,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) {
            return;
          }

          if (syncingFromPropsRef.current) {
            return;
          }

          onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: editorHostRef.current,
    });

    editorViewRef.current = view;

    return () => {
      editorViewRef.current = null;
      view.destroy();
    };
  }, [effectiveShowPreview]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const extensions = shouldRenderLineNumbers ? lineNumbers() : [];
    view.dispatch({ effects: lineNumbersCompartmentRef.current.reconfigure(extensions) });
  }, [shouldRenderLineNumbers]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const extension = wordWrap ? EditorView.lineWrapping : [];
    view.dispatch({ effects: wordWrapCompartmentRef.current.reconfigure(extension) });
  }, [wordWrap]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const extensions = readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
    view.dispatch({ effects: readOnlyCompartmentRef.current.reconfigure(extensions) });
  }, [readOnly]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({ effects: languageCompartmentRef.current.reconfigure(languageExtension ?? []) });
  }, [languageExtension]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    view.dispatch({ effects: themeCompartmentRef.current.reconfigure(darkThemeActive ? [oneDark] : []) });
  }, [darkThemeActive]);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) {
      return;
    }

    const currentContent = view.state.doc.toString();
    if (currentContent === content) {
      return;
    }

    syncingFromPropsRef.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    });
    syncingFromPropsRef.current = false;
  }, [content]);

  return (
    <div className="file-editor-container">
      {isMarkdown ? (
        <div className="file-editor-toolbar">
          <div className="file-editor-mode-toggle">
            {!readOnly && (
              <button
                className={`btn btn-sm ${!effectiveShowPreview ? "btn-primary" : ""}`}
                onClick={handleEditClick}
                disabled={!effectiveShowPreview}
                aria-label="Edit mode"
              >
                <FileEdit size={14} />
                Edit
              </button>
            )}
            <button
              className={`btn btn-sm ${effectiveShowPreview ? "btn-primary" : ""}`}
              onClick={handlePreviewClick}
              disabled={effectiveShowPreview}
              aria-label="Preview mode"
            >
              <Eye size={14} />
              Preview
            </button>
          </div>
          {!readOnly && (
            <div className="file-editor-toolbar-actions">
              {hasSecondaryActions && (
                <>
                  <button
                    className="btn btn-sm btn-icon"
                    onClick={handleToolbarActionsToggle}
                    aria-label="Toggle editor options"
                    title="Toggle editor options"
                    aria-expanded={toolbarActionsExpanded}
                    aria-controls={toolbarActionsId}
                  >
                    {toolbarActionsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <div className="file-editor-toolbar-collapsible" id={toolbarActionsId} hidden={!toolbarActionsExpanded}>
                    {shouldShowLineNumbersToggle && (
                      <button
                        className={`btn btn-sm file-editor-line-numbers-button ${showLineNumbers ? "btn-primary" : ""}`}
                        onClick={onToggleLineNumbers}
                        aria-label="Toggle line numbers"
                        aria-pressed={showLineNumbers}
                        title="Toggle line numbers"
                      >
                        <ListOrdered size={14} />
                        <span>Line #</span>
                      </button>
                    )}
                    <button
                      className={`btn btn-sm ${wordWrap ? "btn-primary" : ""}`}
                      onClick={handleWordWrapToggle}
                      aria-label="Toggle word wrap"
                      title="Toggle word wrap"
                    >
                      <WrapText size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        !readOnly && (
          <div className="file-editor-toolbar">
            <div className="file-editor-mode-toggle" />
            <div className="file-editor-toolbar-actions">
              {hasSecondaryActions && (
                <>
                  <button
                    className="btn btn-sm btn-icon"
                    onClick={handleToolbarActionsToggle}
                    aria-label="Toggle editor options"
                    title="Toggle editor options"
                    aria-expanded={toolbarActionsExpanded}
                    aria-controls={toolbarActionsId}
                  >
                    {toolbarActionsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <div className="file-editor-toolbar-collapsible" id={toolbarActionsId} hidden={!toolbarActionsExpanded}>
                    {shouldShowLineNumbersToggle && (
                      <button
                        className={`btn btn-sm file-editor-line-numbers-button ${showLineNumbers ? "btn-primary" : ""}`}
                        onClick={onToggleLineNumbers}
                        aria-label="Toggle line numbers"
                        aria-pressed={showLineNumbers}
                        title="Toggle line numbers"
                      >
                        <ListOrdered size={14} />
                        <span>Line #</span>
                      </button>
                    )}
                    <button
                      className={`btn btn-sm ${wordWrap ? "btn-primary" : ""}`}
                      onClick={handleWordWrapToggle}
                      aria-label="Toggle word wrap"
                      title="Toggle word wrap"
                    >
                      <WrapText size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      )}

      {effectiveShowPreview ? (
        <div className="file-editor-preview markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <div
          className="file-editor-codemirror"
          ref={editorHostRef}
          aria-label={filePath ? `Editor for ${filePath}` : "File editor"}
        />
      )}
    </div>
  );
}
