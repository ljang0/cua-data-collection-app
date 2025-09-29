import argparse
import json
from pathlib import Path
from typing import Dict, List


def resolve_default_data_root() -> Path:
	return Path(__file__).resolve().parent / "data"


def read_llm_events(task_dir: Path) -> List[Dict]:
	path = task_dir / "llm_events.json"
	if not path.exists():
		raise FileNotFoundError(f"Missing llm_events.json in {task_dir}")
	with path.open("r", encoding="utf-8") as f:
		return json.load(f)


def build_messages_for_task(task_name: str, events: List[Dict]):
	messages: List[Dict] = []
	# System prompt: brief instruction for how to interpret events
	system_content = (
		"You are an agent viewing a screenshot from the user and then emitting the action. "
		"Clicks are provided as normalized ratios (x/width, y/height)."
	)
	messages.append({"role": "system", "content": system_content})

	# Build conversation where user provides the screenshot path (as attachments),
	# then the assistant specifies the action to take using normalized coordinates for clicks.
	attachments: List[str] = []

	for ev in events:
		etype = ev.get("type")
		ss_path = ev.get("ss_path")
		attachment_index = len(attachments)
		attachments.append(ss_path)
		if etype == "click":
			x = ev.get("x")
			y = ev.get("y")
			w = ev.get("width_display") or 0
			h = ev.get("height_display") or 0
			if not (isinstance(w, (int, float)) and isinstance(h, (int, float)) and w > 0 and h > 0):
				# If width/height missing, skip normalization but still emit raw
				rx = x
				ry = y
			else:
				rx = float(x) / float(w) if w else x
				ry = float(y) / float(h) if h else y
			# User: pre-action screenshot attachment reference
			if attachment_index == 0:
				messages.append({"role": "user", "content": f"TASK:{task_name} <attachment:{attachment_index}>"})
			else:
				messages.append({"role": "user", "content": f"<attachment:{attachment_index}>"})
			button = (ev.get("button") or "left").lower()
			verb = "right_click" if button == "right" else "click"
			messages.append({"role": "assistant", "content": f"{verb}: ({rx:.6f}, {ry:.6f})"})
		elif etype == "type":
			key_text = ev.get("key", "")
			# User: pre-action screenshot attachment reference
			if attachment_index == 0:
				messages.append({"role": "user", "content": f"TASK:{task_name} <attachment:{attachment_index}>"})
			else:
				messages.append({"role": "user", "content": f"<attachment:{attachment_index}>"})
			# Assistant: typing instruction
			messages.append({"role": "assistant", "content": f"type: {key_text}"})
		elif etype == "scroll":
			direction = ev.get("direction")
			total_amount = ev.get("total_amount")
			duration = ev.get("duration")
			individual_scrolls = ev.get("individual_scrolls")
			# User: pre-scroll screenshot attachment reference
			if attachment_index == 0:
				messages.append({"role": "user", "content": f"TASK:{task_name} <attachment:{attachment_index}>"})
			else:
				messages.append({"role": "user", "content": f"<attachment:{attachment_index}>"})
			# Assistant: scroll instruction
			messages.append({"role": "assistant", "content": f"scroll: {direction} {total_amount} {duration} {individual_scrolls}"})
		elif etype == "stop":
			# User: pre-stop screenshot attachment reference
			if attachment_index == 0:
				messages.append({"role": "user", "content": f"TASK:{task_name} <attachment:{attachment_index}>"})
			else:
				messages.append({"role": "user", "content": f"<attachment:{attachment_index}>"})
			messages.append({"role": "assistant", "content": "stop"})
	return messages, attachments


def write_jsonl(path: Path, records: List[Dict]) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	with path.open("w", encoding="utf-8") as f:
		for rec in records:
			f.write(json.dumps(rec, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
	parser = argparse.ArgumentParser(description="Make chat-style JSONL from llm_events.json files")
	parser.add_argument("--data-root", default=str(resolve_default_data_root()))
	parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "chat_dataset.jsonl"))
	args = parser.parse_args()

	data_root = Path(args.data_root)
	out_path = Path(args.out)

	all_task_dirs = [p for p in data_root.iterdir() if p.is_dir()]
	success_count = 0

	for task_dir in sorted(all_task_dirs):
		task_name = task_dir.name
		try:
			events = read_llm_events(task_dir)
			messages, attachments = build_messages_for_task(task_name, events)
			# Write per-task JSONL
			per_task_path = task_dir / "chat.jsonl"
			write_jsonl(per_task_path, [{"messages": messages, "attachments": attachments, "task": task_name}])
			success_count += 1
		except Exception as exc:
			print(f"Warning: {task_name}: {exc}")

	print(f"Wrote chat.jsonl for {success_count} task(s) under {data_root}")


if __name__ == "__main__":
	main()
