import argparse
import json
import os
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio


ATTACHMENT_RE = re.compile(r"<attachment:(\d+)>")


def resolve_default_data_root() -> Path:
	return Path(__file__).resolve().parent / "data"


def read_chat_records(chat_path: Path) -> List[Dict]:
	with chat_path.open("r", encoding="utf-8") as f:
		text = f.read()
		s = text.strip()
		if not s:
			return []
		# If the file contains a single pretty-printed object
		if s.startswith("{"):
			return [json.loads(s)]
		# If the file contains a JSON array
		if s.startswith("["):
			return json.loads(s)
		# Otherwise, treat as NDJSON (one JSON per line)
		return [json.loads(line) for line in text.splitlines() if line.strip()]


def parse_steps(messages: List[Dict], attachments: List[str]) -> List[Tuple[str, str]]:
	"""Return ordered (image_path, action_text) for each user/assistant pair.
	Skips system messages and ignores steps where assets are missing.
	"""
	steps: List[Tuple[str, str]] = []
	pending_image: Optional[str] = None
	for msg in messages:
		role = msg.get("role")
		content = msg.get("content", "")
		if role == "user":
			match = ATTACHMENT_RE.search(content)
			if not match:
				continue
			idx = int(match.group(1))
			if 0 <= idx < len(attachments):
				pending_image = attachments[idx]
			else:
				pending_image = None
		elif role == "assistant":
			if pending_image is None:
				continue
			action_text = content
			steps.append((pending_image, action_text))
			pending_image = None
	return steps


def resolve_image_path(path_str: str) -> Optional[Path]:
	"""Try multiple locations to find the image path."""
	candidate = Path(path_str)
	if candidate.exists():
		return candidate
	# Try relative to project root (this script's parent)
	proj = Path(__file__).resolve().parent
	candidate2 = proj / path_str
	if candidate2.exists():
		return candidate2
	# Try relative to current working directory
	candidate3 = Path.cwd() / path_str
	if candidate3.exists():
		return candidate3
	return None


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> List[str]:
	words = text.split()
	lines: List[str] = []
	current: List[str] = []
	for word in words:
		trial = (" ".join(current + [word])).strip()
		bbox = draw.textbbox((0, 0), trial, font=font)
		w = (bbox[2] - bbox[0]) if bbox else 0
		if w <= max_width or not current:
			current.append(word)
		else:
			lines.append(" ".join(current))
			current = [word]
	if current:
		lines.append(" ".join(current))
	return lines


def load_font_prefer_system(size: int) -> ImageFont.ImageFont:
	"""Try loading a large, readable system font; fallback to DejaVu; then default."""
	font_candidates = [
		"/Library/Fonts/Arial.ttf",  # macOS common
		"/System/Library/Fonts/Supplemental/Arial.ttf",
		"/System/Library/Fonts/Helvetica.ttc",
		"/System/Library/Fonts/SFNS.ttf",
		"DejaVuSans.ttf",
	]
	for path in font_candidates:
		try:
			return ImageFont.truetype(path, size=size)
		except Exception:
			continue
	return ImageFont.load_default()


def choose_font_that_fits(draw: ImageDraw.ImageDraw, text: str, panel_w: int, panel_h: int) -> ImageFont.ImageFont:
	"""Start large and shrink until text fits vertically within the panel."""
	margin = max(16, int(panel_h * 0.04))
	max_text_width = panel_w - 2 * margin
	max_size = max(24, int(panel_h * 0.12))
	min_size = 14
	size = max_size
	while size >= min_size:
		font = load_font_prefer_system(size)
		lines = wrap_text(draw, text, font, max_text_width)
		line_height = int(font.size * 1.35)
		total_h = len(lines) * line_height + 2 * margin
		if total_h <= panel_h:
			return font
		size -= 2
	# Fallback smallest
	return load_font_prefer_system(min_size)


def render_frame(image_path: Path, action_text: str, target_size: Optional[Tuple[int, int]] = None) -> np.ndarray:
	# Load and size base image (left side)
	img = Image.open(image_path).convert("RGB")
	if target_size is not None:
		img = img.resize(target_size, Image.BICUBIC)
	img_w, img_h = img.size

	# Create composite canvas with right-side text panel
	panel_w = int(img_w * 0.7)
	canvas = Image.new("RGB", (img_w + panel_w, img_h), color=(255, 255, 255))
	canvas.paste(img, (0, 0))
	draw = ImageDraw.Draw(canvas)

	# Panel background (light)
	panel_x0 = img_w
	panel_y0 = 0
	panel_x1 = img_w + panel_w
	panel_y1 = img_h
	draw.rectangle([(panel_x0, panel_y0), (panel_x1, panel_y1)], fill=(250, 250, 250))

	# Choose a larger font that fits
	font = choose_font_that_fits(draw, action_text, panel_w, img_h)

	# Text layout in panel
	margin = max(16, int(img_h * 0.04))
	max_text_width = panel_w - 2 * margin
	lines = wrap_text(draw, action_text, font, max_text_width)

	text_x = panel_x0 + margin
	text_y = margin
	line_height = int(font.size * 1.35)
	for line in lines:
		draw.text((text_x, text_y), line, font=font, fill=(20, 20, 20))
		text_y += line_height

	return np.array(canvas)


def steps_to_video(steps: List[Tuple[str, str]], output_path: Path, step_duration: float = 2.0, fps: int = 1) -> None:
	if not steps:
		raise ValueError("No steps to render")
	# Ensure consistent size across frames (find first existing image)
	base_size: Optional[Tuple[int, int]] = None
	for path_str, _ in steps:
		p = resolve_image_path(path_str)
		if p is None:
			continue
		with Image.open(p).convert("RGB") as base_img:
			base_size = base_img.size
		break
	if base_size is None:
		raise FileNotFoundError("Could not find any existing image among attachments to determine frame size")

	repeats = max(1, int(round(step_duration * fps)))
	output_path.parent.mkdir(parents=True, exist_ok=True)
	with imageio.get_writer(str(output_path), fps=fps, codec="libx264") as writer:
		for image_path_str, action_text in steps:
			image_path = resolve_image_path(image_path_str)
			if image_path is None:
				print(f"Warning: missing image {image_path_str}")
				continue
			frame = render_frame(image_path, action_text, target_size=base_size)
			for _ in range(repeats):
				writer.append_data(frame)


def process_task(chat_path: Path, out_path: Optional[Path], step_duration: float, fps: int) -> Optional[Path]:
	records = read_chat_records(chat_path)
	if not records:
		print(f"Warning: empty chat file: {chat_path}")
		return None
	rec = records[0]
	messages = rec.get("messages", [])
	attachments = rec.get("attachments", [])
	steps = parse_steps(messages, attachments)
	if not steps:
		print(f"Warning: no steps parsed for {chat_path}")
		return None
	if out_path is None:
		out_path = chat_path.parent / "chat.mp4"
	steps_to_video(steps, out_path, step_duration=step_duration, fps=fps)
	return out_path


def main() -> None:
	parser = argparse.ArgumentParser(description="Build videos from chat.jsonl by stitching images with overlayed actions")
	parser.add_argument("--data-root", default=str(resolve_default_data_root()))
	parser.add_argument("--task", help="Specific task directory name to process", default=None)
	parser.add_argument("--input", help="Path to a specific chat.jsonl", default=None)
	parser.add_argument("--out", help="Output video path (only for --input)", default=None)
	parser.add_argument("--step-duration", type=float, default=2.0)
	parser.add_argument("--fps", type=int, default=1)
	args = parser.parse_args()

	if args.input:
		chat_path = Path(args.input)
		out_path = Path(args.out) if args.out else None
		produced = process_task(chat_path, out_path, args.step_duration, args.fps)
		if produced:
			print(f"Wrote {produced}")
		return

	data_root = Path(args.data_root)
	if args.task:
		task_dir = data_root / args.task
		chat_path = task_dir / "chat.jsonl"
		produced = process_task(chat_path, None, args.step_duration, args.fps)
		if produced:
			print(f"Wrote {produced}")
		return

	# Otherwise process all tasks under data_root
	count = 0
	for task_dir in sorted([p for p in data_root.iterdir() if p.is_dir()]):
		chat_path = task_dir / "chat.jsonl"
		if not chat_path.exists():
			continue
		try:
			produced = process_task(chat_path, None, args.step_duration, args.fps)
			if produced:
				count += 1
		except Exception as exc:
			print(f"Warning: {task_dir.name}: {exc}")
	print(f"Wrote videos for {count} task(s) under {data_root}")


if __name__ == "__main__":
	main()
