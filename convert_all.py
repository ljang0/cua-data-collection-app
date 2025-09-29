import argparse
from pathlib import Path
from typing import Dict

# Import internal modules
import convert_raw as cr
import make_chat_data as mcd


def run_convert_events(data_root: Path) -> int:
	"""Generate llm_events.json for each task under data_root using convert_raw."""
	all_tasks: Dict[str, Dict] = cr.load_all_tasks(data_root)
	generated = 0
	for task_name in sorted(all_tasks.keys()):
		data = all_tasks[task_name]
		llm_events = cr.convert_to_llm_format(task_name, data)
		out_path = data_root / task_name / "llm_events.json"
		cr.write_json(out_path, llm_events)
		generated += 1
	return generated


def run_make_chat(data_root: Path) -> int:
	"""Generate per-task chat.jsonl files using make_chat_data."""
	count = 0
	for task_dir in sorted([p for p in data_root.iterdir() if p.is_dir()]):
		try:
			events = mcd.read_llm_events(task_dir)
			messages, attachments = mcd.build_messages_for_task(task_dir.name, events)
			per_task_path = task_dir / "chat.jsonl"
			mcd.write_jsonl(per_task_path, [{"messages": messages, "attachments": attachments, "task": task_dir.name}])
			count += 1
		except Exception as exc:
			print(f"Warning: {task_dir.name}: {exc}")
	return count


def main() -> None:
	parser = argparse.ArgumentParser(description="Run conversion to llm_events and chat JSONL")
	parser.add_argument(
		"--data-root",
		type=str,
		default=str(cr.resolve_default_data_root()),
		help="Path to data directory containing task subdirectories",
	)
	parser.add_argument("--skip-events", action="store_true", help="Skip generating llm_events.json")
	parser.add_argument("--skip-chat", action="store_true", help="Skip generating per-task chat.jsonl")
	args = parser.parse_args()

	data_root = Path(args.data_root)
	if not data_root.exists():
		raise FileNotFoundError(f"Data root not found: {data_root}")

	if not args.skip_events:
		count_events = run_convert_events(data_root)
		print(f"Generated llm_events.json for {count_events} task(s)")

	if not args.skip_chat:
		count_chats = run_make_chat(data_root)
		print(f"Generated chat.jsonl for {count_chats} task(s)")


if __name__ == "__main__":
	main()
