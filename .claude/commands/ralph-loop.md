Run the Ralph Loop autonomous agent for a given task.

## What to do

1. Read the user's task description from the argument: $ARGUMENTS
2. If no argument is provided, explain Ralph Loop usage and available commands.
3. Execute the task using the Ralph Loop pattern:
   - Decompose the task into steps using `src/services/aiEmployee/chatTaskDecomposer.js`
   - For each step, identify the appropriate builtin tool from `src/services/aiEmployee/builtinToolCatalog.js`
   - Execute each step sequentially, checking results before proceeding
   - If a step fails, analyze the error and decide whether to retry, skip, or abort
4. Report results after each step completes.

## Key files

- `src/services/aiEmployee/ralphLoopAdapter.js` — Ralph Loop adapter (abort, config)
- `src/services/aiEmployee/orchestrator.js` — Task orchestrator
- `src/services/aiEmployee/chatTaskDecomposer.js` — Task decomposition
- `src/services/aiEmployee/builtinToolCatalog.js` — Available tools
- `src/views/DecisionSupportView/index.jsx` — Chat command handler

## Available sub-commands

- `/ralph-loop <task description>` — Execute a task autonomously
- `/ralph-loop status` — Show current Ralph Loop configuration
- `/ralph-loop config` — Show env vars and settings

## Configuration

- `VITE_RALPH_LOOP_ENABLED` — Enable/disable globally (default: false)
- `VITE_RALPH_MAX_ITERATIONS` — Max loop iterations (default: 30)
- `VITE_RALPH_MAX_COST` — Max LLM cost per task in USD (default: 5.00)
- `VITE_RALPH_LLM_MODEL` — LLM model to use (default: anthropic/claude-sonnet-4.5)
