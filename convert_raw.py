import argparse
import json
import os
from pathlib import Path
from typing import Dict, List, Tuple


def resolve_default_data_root() -> Path:
	"""Resolve the default data root relative to this script."""
	return Path(__file__).resolve().parent / "data"


def find_task_directories(data_root: Path) -> List[Path]:
	"""Return a list of subdirectories in data_root that represent tasks."""
	if not data_root.exists() or not data_root.is_dir():
		raise FileNotFoundError(f"Data directory not found: {data_root}")

	task_directories: List[Path] = []
	for entry in os.scandir(data_root):
		if entry.is_dir():
			task_directories.append(Path(entry.path))

	return sorted(task_directories)


def load_session_json(task_directory: Path) -> Tuple[str, Dict]:
	"""Load session_data.json for a given task directory.

	Returns a tuple of (task_name, json_dict).
	"""
	session_path = task_directory / "session_data.json"
	if not session_path.exists():
		raise FileNotFoundError(f"Missing session_data.json in {task_directory}")

	with session_path.open("r", encoding="utf-8") as f:
		data = json.load(f)

	return task_directory.name, data


def load_all_tasks(data_root: Path) -> Dict[str, Dict]:
	"""Load session JSON for all tasks under data_root.

	Returns a mapping of task_name -> session_json.
	"""
	results: Dict[str, Dict] = {}
	for task_dir in find_task_directories(data_root):
		try:
			task_name, data = load_session_json(task_dir)
			results[task_name] = data
		except Exception as exc:
			print(f"Warning: Skipping {task_dir.name}: {exc}")

	return results


def convert_to_llm_format(task_name: str, data: Dict) -> List[Dict]:
	"""Convert events to an LLM-friendly format."""
	llm_format: List[Dict] = []
	events = data.get("events", [])
	key_accumulated = ""
	first_key_path = None
	counter = 0
	for i, event in enumerate(events):
		event_id = event.get("id")
		action_type = event.get("type")
		ss_path = f"data/{task_name}/videos/frames_display_1/event_{event_id}.png"
		if action_type == "click":
			x = event["x"]
			y = event["y"]
			screen_info = event.get("screenInfo") or {}
			current_display = screen_info.get("currentDisplay") or {}
			bounds = current_display.get("bounds") or {}
			width_display = bounds.get("width")
			height_display = bounds.get("height")
			llm_format.append({
				"id": counter,
				"type": action_type,
				"x": x,
				"y": y,
				"width_display": width_display,
				"height_display": height_display,
				"ss_path": ss_path,
				"button": event.get("button"),
			})
			counter += 1
		elif action_type in ("type", "key_combination"):
			current_key = event.get("key", "")
			if first_key_path is None:
				first_key_path = ss_path
			if current_key == "SPACE":
				current_key = " "
			if current_key == "NUMPAD_ENTER":
				current_key = " + ENTER"
			key_accumulated += current_key
			next_is_key = False
			if i + 1 < len(events):
				next_type = events[i + 1].get("type")
				next_is_key = next_type in ("type", "key_combination")
			if next_is_key:
				continue
			llm_format.append({
				"id": counter,
				"type": "type",
				"key": key_accumulated,
				"ss_path": first_key_path,
			})
			key_accumulated = ""
			first_key_path = None
			counter += 1
		elif action_type == "scroll_sequence":
			direction = event.get("direction")
			total_amount = event.get("totalAmount")
			duration = event.get("duration")
			individual_scrolls = event.get("individualScrolls")
			llm_format.append({
				"id": counter,
				"type": "scroll",
				"direction": direction,
				"total_amount": total_amount,
				"duration": duration,
				"individual_scrolls": individual_scrolls,
				"ss_path": ss_path,
			})
			counter += 1
	# Flush any remaining accumulated keys at the end
	if key_accumulated:
		llm_format.append({
			"id": counter,
			"type": "type",
			"key": key_accumulated,
			"ss_path": first_key_path,
		})
		key_accumulated = ""
		first_key_path = None
		counter += 1
	# Append a final stop event with the next id
	llm_format.append({
		"id": counter,
		"type": "stop",
		"ss_path": f"data/{task_name}/videos/frames_display_1/event_{len(events)}.png",
	})
	return llm_format


def write_json(path: Path, payload: List[Dict]) -> None:
	"""Write payload to JSON file with UTF-8 encoding."""
	path.parent.mkdir(parents=True, exist_ok=True)
	with path.open("w", encoding="utf-8") as f:
		json.dump(payload, f, ensure_ascii=False, indent=2)


def main() -> None:
	parser = argparse.ArgumentParser(description="Load session_data.json for each task in data/")
	parser.add_argument(
		"--data-root",
		type=str,
		help="Path to data directory containing task subdirectories",
		default=str(resolve_default_data_root()),
	)
	args = parser.parse_args()
	data_root = Path(args.data_root)

	all_tasks = load_all_tasks(data_root)

	if not all_tasks:
		print("No tasks loaded.")
		return

	print(f"Loaded {len(all_tasks)} task(s) from {data_root}")
	for task_name in sorted(all_tasks.keys()):
		data = all_tasks[task_name]
		num_events = len(data.get("events", [])) if isinstance(data, dict) else 0
		llm_events = convert_to_llm_format(task_name, data)
		output_path = data_root / task_name / "llm_events.json"
		write_json(output_path, llm_events)
		print(f"- {task_name}: events={num_events}")

if __name__ == "__main__":
	main()


