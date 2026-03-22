import sys
sys.path.append('./')
from PIL import Image, ImageFilter, ImageOps
import gradio as gr
from src.tryon_pipeline import StableDiffusionXLInpaintPipeline as TryonPipeline
from src.unet_hacked_garmnet import UNet2DConditionModel as UNet2DConditionModel_ref
from src.unet_hacked_tryon import UNet2DConditionModel
from transformers import (
    CLIPImageProcessor,
    CLIPVisionModelWithProjection,
    CLIPTextModel,
    CLIPTextModelWithProjection,
)
from diffusers import DDPMScheduler,AutoencoderKL
from typing import List

import torch
import os
from transformers import AutoTokenizer
import numpy as np
from torchvision import transforms
import apply_net
from preprocess.humanparsing.run_parsing import Parsing
from preprocess.openpose.run_openpose import OpenPose
from detectron2.data.detection_utils import convert_PIL_to_numpy,_apply_exif_orientation
from torchvision.transforms.functional import to_pil_image


import cv2 
import tempfile 
import imageio 
import math 
import glob 
import logging 

from diffusers import StableDiffusionControlNetInpaintPipeline, ControlNetModel
import json
from diffusers import StableDiffusionInpaintPipeline
from capvton_utils.garment_agnostic_mask_predictor import AutoMasker
logging.basicConfig(level=logging.INFO)
from capvton_utils.densepose_for_mask import DensePose
from preprocess.openpose.run_openpose import OpenPose
logger = logging.getLogger(__name__)

device = 'cuda:0' if torch.cuda.is_available() else 'cpu'

def pil_to_binary_mask(pil_image, threshold=0):
    np_image = np.array(pil_image)
    grayscale_image = Image.fromarray(np_image).convert("L")
    binary_mask = np.array(grayscale_image) > threshold
    mask = np.zeros(binary_mask.shape, dtype=np.uint8)
    for i in range(binary_mask.shape[0]):
        for j in range(binary_mask.shape[1]):
            if binary_mask[i,j] == True :
                mask[i,j] = 1
    mask = (mask*255).astype(np.uint8)
    output_mask = Image.fromarray(mask)
    return output_mask


base_path = 'IDM-VTON'
example_path = os.path.join(os.path.dirname(__file__), 'example')

unet = UNet2DConditionModel.from_pretrained(
    base_path,
    subfolder="unet",
    torch_dtype=torch.float16,
)
unet.requires_grad_(False)
tokenizer_one = AutoTokenizer.from_pretrained(
    base_path,
    subfolder="tokenizer",
    revision=None,
    use_fast=False,
)
tokenizer_two = AutoTokenizer.from_pretrained(
    base_path,
    subfolder="tokenizer_2",
    revision=None,
    use_fast=False,
)
noise_scheduler = DDPMScheduler.from_pretrained(base_path, subfolder="scheduler")

text_encoder_one = CLIPTextModel.from_pretrained(
    base_path,
    subfolder="text_encoder",
    torch_dtype=torch.float16,
)
text_encoder_two = CLIPTextModelWithProjection.from_pretrained(
    base_path,
    subfolder="text_encoder_2",
    torch_dtype=torch.float16,
)
image_encoder = CLIPVisionModelWithProjection.from_pretrained(
    base_path,
    subfolder="image_encoder",
    torch_dtype=torch.float16,
    )
vae = AutoencoderKL.from_pretrained(base_path,
                                    subfolder="vae",
                                    torch_dtype=torch.float16,
)

# "stabilityai/stable-diffusion-xl-base-1.0",
UNet_Encoder = UNet2DConditionModel_ref.from_pretrained(
    base_path,
    subfolder="unet_encoder",
    torch_dtype=torch.float16,
)


controlnet = ControlNetModel.from_pretrained(
    "lllyasviel/sd-controlnet-openpose",
    torch_dtype=torch.float16
)

ckpt_path = ""
skin_pipe = StableDiffusionControlNetInpaintPipeline.from_single_file(
    ckpt_path,
    controlnet=controlnet,
    torch_dtype=torch.float16,
    safety_checker=None
).to("cuda")


# Reduce memory usage (efficient attention)
#skin_pipe.enable_xformers_memory_efficient_attention()

parsing_model = Parsing(0)
openpose_model = OpenPose(0)
densepose_model = DensePose("./ckpt/densepose", "cuda")

UNet_Encoder.requires_grad_(False)
image_encoder.requires_grad_(False)
vae.requires_grad_(False)
unet.requires_grad_(False)
text_encoder_one.requires_grad_(False)
text_encoder_two.requires_grad_(False)
tensor_transfrom = transforms.Compose(
            [
                transforms.ToTensor(),
                transforms.Normalize([0.5], [0.5]),
            ]
    )

pipe = TryonPipeline.from_pretrained(
        base_path,
        unet=unet,
        vae=vae,
        feature_extractor= CLIPImageProcessor(),
        text_encoder = text_encoder_one,
        text_encoder_2 = text_encoder_two,
        tokenizer = tokenizer_one,
        tokenizer_2 = tokenizer_two,
        scheduler = noise_scheduler,
        image_encoder=image_encoder,
        torch_dtype=torch.float16,
)
pipe.unet_encoder = UNet_Encoder

mask_predictor = AutoMasker(device=device)

def build_full_upper_body_mask(human_img, model_parse, human_img_size=(768, 1024)):
    """
    Build a mask that covers:
    - full torso using OpenPose keypoints
    - both arms from parsing
    - optional current upper clothes region
    """
    parse = np.array(model_parse)

    # arm regions from parsing
    arms_mask = np.isin(parse, [14, 15]).astype(np.uint8)

    # existing upper clothes / dress as helpful prior
    clothes_mask = np.isin(parse, [4, 7]).astype(np.uint8)

    # blank mask at parsing resolution
    h, w = parse.shape
    torso_mask = np.zeros((h, w), dtype=np.uint8)

    # get openpose result
    openpose_result = openpose_model(human_img)
    if isinstance(openpose_result, dict):
        keypoints = openpose_result.get("pose_keypoints_2d", None)
    else:
        keypoints = None

    if keypoints is not None:
        kp = np.array(keypoints)

        def valid_point(i):
            if i >= len(kp):
                return False
            p = np.array(kp[i]).ravel()
            return len(p) >= 2 and not (p[0] == 0 and p[1] == 0)

        needed = [1, 2, 5, 8, 11]  # neck, shoulders, hips

        if all(valid_point(i) for i in needed):
            neck = np.array(kp[1]).ravel()[:2]
            r_sh = np.array(kp[2]).ravel()[:2]
            l_sh = np.array(kp[5]).ravel()[:2]
            r_hip = np.array(kp[8]).ravel()[:2]
            l_hip = np.array(kp[11]).ravel()[:2]

            # widen shoulders and hips a bit
            shoulder_vec = l_sh - r_sh
            hip_vec = l_hip - r_hip

            r_sh_out = r_sh - 0.15 * shoulder_vec
            l_sh_out = l_sh + 0.15 * shoulder_vec
            r_hip_out = r_hip - 0.10 * hip_vec
            l_hip_out = l_hip + 0.10 * hip_vec

            # torso polygon
            poly = np.array([
                r_sh_out,
                l_sh_out,
                l_hip_out,
                r_hip_out
            ], dtype=np.int32)

            cv2.fillConvexPoly(torso_mask, poly, 1)

    # combine torso + arms + current clothes
    mask = torso_mask | arms_mask | clothes_mask

    # strong dilation to ensure sleeve / edge coverage
    kernel = np.ones((25, 25), np.uint8)
    mask = cv2.dilate(mask.astype(np.uint8), kernel, iterations=2)

    return Image.fromarray(mask * 255).resize(human_img_size, Image.NEAREST)

def generate_skin(
    src_image: Image.Image,
    inpaint_mask_img: Image.Image,
    step: int = 20,
    seed: int = 42
) -> Image.Image:
    """
    Remove upper-body clothing / sleeves inside mask and generate a clean body base.
    """

    skin_prompt = "realistic human skin, natural bare arms, clean upper body, photorealistic"
    negative_prompt = (
        "shirt, t-shirt, sleeves, long sleeves, short sleeves, jacket, coat, hoodie, "
        "fabric, blurry, low quality, artifacts, deformed, ugly, watermark, text, "
        "bad anatomy, extra limbs, extra hands, extra fingers"
    )

    openpose_result = openpose_model(src_image)

    if isinstance(openpose_result, dict):
        openpose_image = openpose_result.get("image")
    else:
        openpose_image = openpose_result

    if not isinstance(openpose_image, Image.Image):
        raise TypeError(f"The control image returned from OpenPose is invalid: {type(openpose_image)}")

    generator = torch.Generator(device="cuda").manual_seed(seed)

    generated_image = skin_pipe(
        prompt=skin_prompt,
        negative_prompt=negative_prompt,
        image=src_image,
        mask_image=inpaint_mask_img,
        control_image=openpose_image,
        num_inference_steps=step,
        guidance_scale=7.0,
        generator=generator
    ).images[0]

    # hard blend only inside mask
    src_np = np.array(src_image)
    mask_np = np.array(inpaint_mask_img.convert("L")) / 255.0
    mask_np = np.expand_dims(mask_np, axis=-1)
    generated_np = np.array(generated_image)

    final_np = src_np * (1 - mask_np) + generated_np * mask_np
    final_image = Image.fromarray(final_np.astype(np.uint8))

    return final_image

def render_keypoints_as_image(keypoints, size=(768,1024), radius=3):
    from PIL import Image, ImageDraw
    import numpy as np

    img = Image.new("RGB", size, (0,0,0))
    draw = ImageDraw.Draw(img)

    for kp in keypoints:
        # Flatten kp to 1D
        kp_flat = np.array(kp).ravel()
        if len(kp_flat) <2: 
            continue
        x, y = kp_flat[:2]  
        if x == 0 and y == 0:  # skip missing points
            continue
        draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=(255,255,255))

    return img


def start_tryon(human_img, garm_img, garment_des, garment_type, is_checked, is_checked_crop, denoise_steps, seed):
    
    #======================================================
    # Preprocessing (inputs)
    #======================================================
    openpose_model.preprocessor.body_estimation.model.to(device)
    pipe.to(device)
    pipe.unet_encoder.to(device)

    garm_img= garm_img.convert("RGB").resize((768,1024))
    if isinstance(human_img, dict):
        human_img = human_img['background']

    human_img_orig = human_img.convert("RGB")
    

    # Load human image and crop 
    if is_checked_crop:
        width, height = human_img_orig.size
        target_width = int(min(width, height * (3 / 4)))
        target_height = int(min(height, width * (4 / 3)))
        left = (width - target_width) / 2
        top = (height - target_height) / 2
        right = (width + target_width) / 2
        bottom = (height + target_height) / 2
        cropped_img = human_img_orig.crop((left, top, right, bottom))
        crop_size = cropped_img.size
        human_img = cropped_img.resize((768,1024))
    else:
        human_img = human_img_orig.resize((768,1024))

    # Masking
    if is_checked:
        model_parse, _ = parsing_model(human_img.resize((384,512)))
        model_parse = np.array(model_parse)
    
        # Clean semantic region selection 
        upper_body_mask_np = np.isin(model_parse, [4]).astype(np.uint8)
        arms_mask_np = np.isin(model_parse, [14,15]).astype(np.uint8)
        densepose_map = densepose_model(human_img.resize((384,512)))
        hands_mask_np = np.isin(np.array(densepose_map), [3,4]).astype(np.uint8)
        inpaint_mask_np = upper_body_mask_np | arms_mask_np | hands_mask_np

        # dilation
        kernel = np.ones((3,3),np.uint8)
        inpaint_mask_np = cv2.dilate(inpaint_mask_np, kernel, iterations=1)

        # pose refinement
        pose_mask = mask_predictor(human_img, garment_type="overall")["mask"]
        pose_mask = pose_mask.resize((384,512), Image.NEAREST)
        pose_mask = np.array(pose_mask) > 128
        # resize for diffusion
        inpaint_mask_img = Image.fromarray(inpaint_mask_np * 255).resize((768,1024), Image.NEAREST)
        inpaint_mask_img.save("debug_mask.png")

        mask = inpaint_mask_img

    else:
        mask = pil_to_binary_mask(human_img.convert("RGB").resize((768, 1024)))
        # mask = transforms.ToTensor()(mask)

    # ======================================================
    # Generate clean image 
    # ======================================================

    upper_body_mask_img = build_full_upper_body_mask(
    human_img=human_img.resize((384, 512)),
    model_parse=model_parse,
    human_img_size=(768, 1024)
    )
    
    clean_img = generate_skin(
            src_image=human_img,
            inpaint_mask_img=upper_body_mask_img,
            step=20,
            seed=seed
        )
    
    # ======================================================
    # Cloth mask 
    # ======================================================
    cloth_mask_img = upper_body_mask_img
    pre_tryon_img = clean_img

    # Mask gray as PIL image (keep your original formula)
    mask_gray = (1 - transforms.ToTensor()(cloth_mask_img)) * tensor_transfrom(pre_tryon_img)
    mask_gray = to_pil_image((mask_gray + 1.0)/2.0)  # output is PIL.Image

    # ======================================================
    # DensePose / OpenPose for final try-on
    # ======================================================
    human_img_arg = _apply_exif_orientation(human_img.resize((384,512)))
    human_img_arg = convert_PIL_to_numpy(human_img_arg, format="BGR")

    args = apply_net.create_argument_parser().parse_args(('show', './configs/densepose_rcnn_R_50_FPN_s1x.yaml', './ckpt/densepose/model_final_162be9.pkl', 'dp_segm', '-v', '--opts', 'MODEL.DEVICE', 'cuda'))
    pose_img = args.func(args,human_img_arg)    
    pose_img = pose_img[:,:,::-1]    
    pose_img = Image.fromarray(pose_img).resize((768,1024))

    #======================================================
    # Diffusion inference (generate final try-on image)
    #======================================================
    with torch.no_grad():
        # Extract the images
        with torch.cuda.amp.autocast():
            with torch.no_grad():
                prompt = "model is wearing " + garment_des
                negative_prompt = "monochrome, lowres, bad anatomy, worst quality, low quality"
                with torch.inference_mode():
                    (
                        prompt_embeds,
                        negative_prompt_embeds,
                        pooled_prompt_embeds,
                        negative_pooled_prompt_embeds,
                    ) = pipe.encode_prompt(
                        prompt,
                        num_images_per_prompt=1,
                        do_classifier_free_guidance=True,
                        negative_prompt=negative_prompt,
                    )
                                    
                    prompt = "a photo of " + garment_des
                    negative_prompt = "monochrome, lowres, bad anatomy, worst quality, low quality"
                    if not isinstance(prompt, List):
                        prompt = [prompt] * 1
                    if not isinstance(negative_prompt, List):
                        negative_prompt = [negative_prompt] * 1
                    with torch.inference_mode():
                        (
                            prompt_embeds_c,
                            _,
                            _,
                            _,
                        ) = pipe.encode_prompt(
                            prompt,
                            num_images_per_prompt=1,
                            do_classifier_free_guidance=False,
                            negative_prompt=negative_prompt,
                        )

                    pose_img =  tensor_transfrom(pose_img).unsqueeze(0).to(device,torch.float16)
                    garm_tensor =  tensor_transfrom(garm_img).unsqueeze(0).to(device,torch.float16)
                    generator = torch.Generator(device).manual_seed(seed) if seed is not None else None
                    images = pipe(
                        prompt_embeds=prompt_embeds.to(device,torch.float16),
                        negative_prompt_embeds=negative_prompt_embeds.to(device,torch.float16),
                        pooled_prompt_embeds=pooled_prompt_embeds.to(device,torch.float16),
                        negative_pooled_prompt_embeds=negative_pooled_prompt_embeds.to(device,torch.float16),
                        num_inference_steps=denoise_steps,
                        generator=generator,
                        strength = 1.0,
                        pose_img = pose_img.to(device,torch.float16),
                        text_embeds_cloth=prompt_embeds_c.to(device,torch.float16),
                        cloth = garm_tensor.to(device,torch.float16),
                        mask_image=cloth_mask_img,
                        #image=human_img,  # Raw image, replaced with AI generated (short sleeves, generated skin)
                        image = pre_tryon_img, 
                        height=1024,
                        width=768,
                        ip_adapter_image = garm_img.resize((768,1024)),
                        guidance_scale=2.0,
                    )[0]

    if is_checked_crop:
        out_img = images[0].resize(crop_size)        
        human_img_orig.paste(out_img, (int(left), int(top)))    
        return human_img_orig, mask_gray, clean_img
    else:
        return images[0], mask_gray, clean_img 
    # return images[0], mask_gray

garm_list = os.listdir(os.path.join(example_path,"cloth"))
garm_list_path = [os.path.join(example_path,"cloth",garm) for garm in garm_list]

human_list = os.listdir(os.path.join(example_path,"human"))
human_list_path = [os.path.join(example_path,"human",human) for human in human_list]

human_ex_list = []
for ex_human in human_list_path:
    ex_dict= {}
    ex_dict['background'] = ex_human
    ex_dict['layers'] = None
    ex_dict['composite'] = None
    human_ex_list.append(ex_dict)

##default human


# image_blocks = gr.Blocks().queue()
# with image_blocks as demo:
#     gr.Markdown("## Find Your Ideal Piece 👕👔👚")
#     with gr.Row():
#         with gr.Column():
#             imgs = gr.ImageEditor(sources='upload', type="pil", label='Human. Mask with pen or use auto-masking', interactive=True)
#             with gr.Row():
#                 is_checked = gr.Checkbox(label="Yes", info="Use auto-generated mask (Takes 5 seconds)",value=True)
#             with gr.Row():
#                 is_checked_crop = gr.Checkbox(label="Yes", info="Use auto-crop & resizing",value=False)

#             example = gr.Examples(
#                 inputs=imgs,
#                 examples_per_page=10,
#                 examples=human_ex_list
#             )

#         with gr.Column():
#             garm_img = gr.Image(label="Garment", sources='upload', type="pil")
#             with gr.Row(elem_id="prompt-container"):
#                 with gr.Row():
#                     prompt = gr.Textbox(placeholder="Description of garment ex) Short Sleeve Round Neck T-shirts", show_label=False, elem_id="prompt")
#             example = gr.Examples(
#                 inputs=garm_img,
#                 examples_per_page=8,
#                 examples=garm_list_path)
#         with gr.Column():
#             # image_out = gr.Image(label="Output", elem_id="output-img", height=400)
#             masked_img = gr.Image(label="Masked image output", elem_id="masked-img",show_share_button=False)
#         with gr.Column():
#             # image_out = gr.Image(label="Output", elem_id="output-img", height=400)
#             clean_img = gr.Image(label="Clean image output", elem_id="clean-img",show_share_button=False)
#         with gr.Column():
#             # image_out = gr.Image(label="Output", elem_id="output-img", height=400)
#             image_out = gr.Image(label="Output", elem_id="output-img",show_share_button=False)



#     with gr.Column():
#         try_button = gr.Button(value="Try-on")
#         with gr.Accordion(label="Advanced Settings", open=False):
#             with gr.Row():
#                 denoise_steps = gr.Number(label="Denoising Steps", minimum=20, maximum=40, value=30, step=1)
#                 seed = gr.Number(label="Seed", minimum=-1, maximum=2147483647, step=1, value=42)



#     try_button.click(fn=start_tryon, inputs=[imgs, garm_img, prompt, is_checked,is_checked_crop, denoise_steps, seed], outputs=[masked_img,clean_img,image_out], api_name='tryon')

            


# image_blocks.launch()
