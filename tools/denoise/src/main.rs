//! primestone-denoise <in.f32> <out.f32> [atten_lim_db]
//! Raw 32-bit float, 48 kHz, mono in and out (FFmpeg converts). The model's delay is removed so the
//! output lines up sample for sample with the input; the length is kept.
use std::io::{Read, Write};

use anyhow::{Context, Result};
use deep_filter_rt::tract::DfTract;
use ndarray::Array2;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        anyhow::bail!("usage: primestone-denoise <in.f32> <out.f32> [atten_lim_db]");
    }
    let mut raw = Vec::new();
    std::fs::File::open(&args[1]).context("lecture")?.read_to_end(&mut raw)?;
    let input: Vec<f32> = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    let mut df = DfTract::default();
    if let Some(db) = args.get(3) {
        df.set_atten_lim(db.parse::<f32>().context("atten_lim_db")?);
    }
    let hop = df.hop_size;
    let delay = df.delay();
    let total = input.len() + delay;
    let frames = total.div_ceil(hop);
    let mut out: Vec<f32> = Vec::with_capacity(frames * hop);
    let mut noisy = Array2::<f32>::zeros((df.ch, hop));
    let mut enh = Array2::<f32>::zeros((df.ch, hop));
    for f in 0..frames {
        for i in 0..hop {
            noisy[[0, i]] = *input.get(f * hop + i).unwrap_or(&0.0);
        }
        df.process(noisy.view(), enh.view_mut())?;
        out.extend(enh.row(0).iter().copied());
    }
    let aligned = &out[delay.min(out.len())..(delay + input.len()).min(out.len())];
    let mut file = std::io::BufWriter::new(std::fs::File::create(&args[2]).context("écriture")?);
    for s in aligned {
        file.write_all(&s.to_le_bytes())?;
    }
    file.flush()?;
    eprintln!("ok {} échantillons, délai compensé {} échantillons", aligned.len(), delay);
    Ok(())
}
