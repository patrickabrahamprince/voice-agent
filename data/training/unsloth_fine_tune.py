"""
Mittal Palms Voice Agent — Supervised Fine-Tuning (SFT) Recipe
Optimized for ultra-low latency inference (<150ms TTFT) with Unsloth and Qwen 2.5 7B.

Run with:
  pip install unsloth trl datasets transformers
  python unsloth_fine_tune.py
"""

import torch
from unsloth import FastLanguageModel
from datasets import load_dataset
from trl import SFTTrainer
from transformers import TrainingArguments

max_seq_length = 2048
dtype = None # Auto detection
load_in_4bit = True # 4bit QLoRA for fast training on 1x T4 / A10G / A100

# 1. Load Pretrained Base Model
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen2.5-7B-Instruct",
    max_seq_length=max_seq_length,
    dtype=dtype,
    load_in_4bit=load_in_4bit,
)

# 2. Add LoRA Adapters
model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_alpha=16,
    lora_dropout=0,
    bias="none",
    use_gradient_checkpointing="unsloth",
    random_state=3407,
)

# 3. Load ChatML JSONL Datasets
dataset = load_dataset("json", data_files={"train": "sft_train.jsonl", "test": "sft_val.jsonl"})

def formatting_prompts_func(examples):
    convos = examples["messages"]
    texts = [tokenizer.apply_chat_template(convo, tokenize=False, add_generation_prompt=False) for convo in convos]
    return {"text": texts}

dataset = dataset.map(formatting_prompts_func, batched=True)

# 4. Trainer
trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset["train"],
    eval_dataset=dataset["test"],
    dataset_text_field="text",
    max_seq_length=max_seq_length,
    dataset_num_proc=2,
    packing=False,
    args=TrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        warmup_steps=5,
        max_steps=60,
        learning_rate=2e-4,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=1,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="linear",
        seed=3407,
        output_dir="mittal_palms_lora",
    ),
)

trainer.train()

# 5. Save LoRA Adapters & GGUF for Low-Latency Deployment
model.save_pretrained_merged("mittal_palms_qwen2.5_7b", tokenizer, save_method="merged_16bit")
print("🎉 Model fine-tuning completed successfully! Saved to ./mittal_palms_qwen2.5_7b")
