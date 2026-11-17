//! `qrSvg` of `src/integrations/remote.ts`: a port of the parts of the `qrcode-generator` npm package (1.5.2) it uses,
//! `qrcode(0, "M")`, `addData(text)` (byte mode, each UTF-16 unit `& 0xff`, as the package's default `stringToBytes`),
//! `make()` (the smallest type number that fits, the mask pattern with the fewest lost points) and
//! `createSvgTag({cellSize: 4, margin: 2, scalable: true})`, so the SVG text is the same byte for byte.

/// An error correction level: its bits in the format info (the package's `QRErrorCorrectionLevel`) and its rows of the
/// RS block table.
#[derive(Clone, Copy)]
struct Level {
    bits: u32,
    table: &'static [&'static [usize]; 40],
}

/// Level M (`QRErrorCorrectionLevel.M` is 0), for the SVG.
const M: Level = Level { bits: 0, table: &RS_BLOCK_M };
/// Level L (`QRErrorCorrectionLevel.L` is 1), for the terminal.
const L: Level = Level { bits: 1, table: &RS_BLOCK_L };
const MODE_8BIT: u32 = 1 << 2;
const PAD0: u32 = 0xEC;
const PAD1: u32 = 0x11;

/// The SVG of `text`, as `qrSvg` makes it.
pub fn qr_svg(text: &str) -> String {
    let q = Qr::make(text, M);
    let (cell, margin) = (4usize, 2usize);
    let n = q.count;
    let size = n * cell + margin * 2;
    let rect = format!("l{cell},0 0,{cell} -{cell},0 0,-{cell}z ");
    let mut s = String::new();
    s.push_str("<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\"");
    s.push_str(&format!(" viewBox=\"0 0 {size} {size}\" "));
    s.push_str(" preserveAspectRatio=\"xMinYMin meet\"");
    s.push('>');
    s.push_str("<rect width=\"100%\" height=\"100%\" fill=\"white\" cx=\"0\" cy=\"0\"/>");
    s.push_str("<path d=\"");
    for r in 0..n {
        let mr = r * cell + margin;
        for c in 0..n {
            if q.dark(r, c) {
                let mc = c * cell + margin;
                s.push_str(&format!("M{mc},{mr}{rect}"));
            }
        }
    }
    s.push_str("\" stroke=\"transparent\" fill=\"black\"/>");
    s.push_str("</svg>");
    s
}

/// `qrTerminal` of `src/integrations/remote.ts`: `qrcode(0, "L")`, two module rows per line (▀ ▄ █) with a 2-module
/// quiet zone, light modules drawn (light-on-dark terminals invert).
pub fn qr_terminal(text: &str) -> String {
    let q = Qr::make(text, L);
    let n = q.count as i64;
    let dark = |r: i64, c: i64| r >= 0 && c >= 0 && r < n && c < n && q.dark(r as usize, c as usize);
    let mut lines = Vec::new();
    let mut r = -2;
    while r < n + 2 {
        let mut line = String::new();
        for c in -2..n + 2 {
            let (top, bottom) = (!dark(r, c), !dark(r + 1, c));
            line.push(match (top, bottom) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                _ => ' ',
            });
        }
        lines.push(line);
        r += 2;
    }
    lines.join("\n")
}

struct Qr {
    level: Level,
    type_number: usize,
    count: usize,
    modules: Vec<Vec<Option<bool>>>,
    bytes: Vec<u32>,
    data_cache: Option<Vec<u32>>,
}

impl Qr {
    fn make(text: &str, level: Level) -> Qr {
        let bytes: Vec<u32> = text.encode_utf16().map(|u| (u & 0xff) as u32).collect();
        let mut type_number = 1;
        while type_number < 40 {
            let mut buf = BitBuffer::default();
            put_data(&mut buf, &bytes, type_number);
            let total: usize = rs_blocks(type_number, level).iter().map(|b| b.1).sum();
            if buf.len <= total * 8 {
                break;
            }
            type_number += 1;
        }
        let mut q = Qr { level, type_number, count: 0, modules: Vec::new(), bytes, data_cache: None };
        let best = q.best_mask();
        q.make_impl(false, best);
        q
    }

    fn dark(&self, r: usize, c: usize) -> bool {
        self.modules[r][c] == Some(true)
    }

    fn best_mask(&mut self) -> u32 {
        let mut min = 0f64;
        let mut pattern = 0;
        for i in 0..8 {
            self.make_impl(true, i);
            let lost = self.lost_point();
            if i == 0 || min > lost {
                min = lost;
                pattern = i;
            }
        }
        pattern
    }

    fn make_impl(&mut self, test: bool, mask: u32) {
        self.count = self.type_number * 4 + 17;
        self.modules = vec![vec![None; self.count]; self.count];
        self.probe(0, 0);
        self.probe(self.count as i64 - 7, 0);
        self.probe(0, self.count as i64 - 7);
        self.adjust();
        self.timing();
        self.type_info(test, mask);
        if self.type_number >= 7 {
            self.type_bits(test);
        }
        if self.data_cache.is_none() {
            self.data_cache = Some(create_data(self.type_number, &self.bytes, self.level));
        }
        let data = self.data_cache.clone().unwrap_or_default();
        self.map_data(&data, mask);
    }

    fn probe(&mut self, row: i64, col: i64) {
        let n = self.count as i64;
        for r in -1..=7i64 {
            if row + r <= -1 || n <= row + r {
                continue;
            }
            for c in -1..=7i64 {
                if col + c <= -1 || n <= col + c {
                    continue;
                }
                let on = ((0..=6).contains(&r) && (c == 0 || c == 6))
                    || ((0..=6).contains(&c) && (r == 0 || r == 6))
                    || ((2..=4).contains(&r) && (2..=4).contains(&c));
                self.modules[(row + r) as usize][(col + c) as usize] = Some(on);
            }
        }
    }

    fn adjust(&mut self) {
        let pos = PATTERN_POSITION[self.type_number - 1];
        for &row in pos {
            for &col in pos {
                if self.modules[row][col].is_some() {
                    continue;
                }
                for r in -2..=2i64 {
                    for c in -2..=2i64 {
                        let on = r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0);
                        self.modules[(row as i64 + r) as usize][(col as i64 + c) as usize] = Some(on);
                    }
                }
            }
        }
    }

    fn timing(&mut self) {
        for r in 8..self.count - 8 {
            if self.modules[r][6].is_none() {
                self.modules[r][6] = Some(r % 2 == 0);
            }
        }
        for c in 8..self.count - 8 {
            if self.modules[6][c].is_none() {
                self.modules[6][c] = Some(c % 2 == 0);
            }
        }
    }

    fn type_bits(&mut self, test: bool) {
        let bits = bch_type_number(self.type_number as u32);
        let n = self.count;
        for i in 0..18 {
            let m = !test && ((bits >> i) & 1) == 1;
            self.modules[i / 3][i % 3 + n - 8 - 3] = Some(m);
        }
        for i in 0..18 {
            let m = !test && ((bits >> i) & 1) == 1;
            self.modules[i % 3 + n - 8 - 3][i / 3] = Some(m);
        }
    }

    fn type_info(&mut self, test: bool, mask: u32) {
        let data = (self.level.bits << 3) | mask;
        let bits = bch_type_info(data);
        let n = self.count;
        for i in 0..15 {
            let m = Some(!test && ((bits >> i) & 1) == 1);
            if i < 6 {
                self.modules[i][8] = m;
            } else if i < 8 {
                self.modules[i + 1][8] = m;
            } else {
                self.modules[n - 15 + i][8] = m;
            }
        }
        for i in 0..15 {
            let m = Some(!test && ((bits >> i) & 1) == 1);
            if i < 8 {
                self.modules[8][n - i - 1] = m;
            } else if i < 9 {
                self.modules[8][15 - i - 1 + 1] = m;
            } else {
                self.modules[8][15 - i - 1] = m;
            }
        }
        self.modules[n - 8][8] = Some(!test);
    }

    fn map_data(&mut self, data: &[u32], mask: u32) {
        let n = self.count as i64;
        let mut inc = -1i64;
        let mut row = n - 1;
        let mut bit_index = 7i32;
        let mut byte_index = 0usize;
        let mut col = n - 1;
        while col > 0 {
            if col == 6 {
                col -= 1;
            }
            loop {
                for c in 0..2 {
                    let (r, cc) = (row as usize, (col - c) as usize);
                    if self.modules[r][cc].is_none() {
                        let mut dark = byte_index < data.len() && ((data[byte_index] >> bit_index) & 1) == 1;
                        if mask_at(mask, row, col - c) {
                            dark = !dark;
                        }
                        self.modules[r][cc] = Some(dark);
                        bit_index -= 1;
                        if bit_index == -1 {
                            byte_index += 1;
                            bit_index = 7;
                        }
                    }
                }
                row += inc;
                if row < 0 || n <= row {
                    row -= inc;
                    inc = -inc;
                    break;
                }
            }
            col -= 2;
        }
    }

    fn lost_point(&self) -> f64 {
        let n = self.count;
        let d = |r: usize, c: usize| self.dark(r, c);
        let mut lost = 0f64;
        for row in 0..n {
            for col in 0..n {
                let mut same = 0;
                let dark = d(row, col);
                for r in -1..=1i64 {
                    let rr = row as i64 + r;
                    if rr < 0 || n as i64 <= rr {
                        continue;
                    }
                    for c in -1..=1i64 {
                        let cc = col as i64 + c;
                        if cc < 0 || n as i64 <= cc || (r == 0 && c == 0) {
                            continue;
                        }
                        if dark == d(rr as usize, cc as usize) {
                            same += 1;
                        }
                    }
                }
                if same > 5 {
                    lost += (3 + same - 5) as f64;
                }
            }
        }
        for row in 0..n - 1 {
            for col in 0..n - 1 {
                let count = [d(row, col), d(row + 1, col), d(row, col + 1), d(row + 1, col + 1)].iter().filter(|x| **x).count();
                if count == 0 || count == 4 {
                    lost += 3.0;
                }
            }
        }
        let finder = |get: &dyn Fn(usize) -> bool| get(0) && !get(1) && get(2) && get(3) && get(4) && !get(5) && get(6);
        for row in 0..n {
            for col in 0..n.saturating_sub(6) {
                if finder(&|k| d(row, col + k)) {
                    lost += 40.0;
                }
            }
        }
        for col in 0..n {
            for row in 0..n.saturating_sub(6) {
                if finder(&|k| d(row + k, col)) {
                    lost += 40.0;
                }
            }
        }
        let mut dark = 0usize;
        for col in 0..n {
            for row in 0..n {
                if d(row, col) {
                    dark += 1;
                }
            }
        }
        let ratio = (100.0 * dark as f64 / n as f64 / n as f64 - 50.0).abs() / 5.0;
        lost + ratio * 10.0
    }
}

fn mask_at(mask: u32, i: i64, j: i64) -> bool {
    match mask {
        0 => (i + j) % 2 == 0,
        1 => i % 2 == 0,
        2 => j % 3 == 0,
        3 => (i + j) % 3 == 0,
        4 => (i / 2 + j / 3) % 2 == 0,
        5 => (i * j) % 2 + (i * j) % 3 == 0,
        6 => ((i * j) % 2 + (i * j) % 3) % 2 == 0,
        _ => ((i * j) % 3 + (i + j) % 2) % 2 == 0,
    }
}

fn bch_digit(mut d: u32) -> i32 {
    let mut n = 0;
    while d != 0 {
        n += 1;
        d >>= 1;
    }
    n
}

const G15: u32 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G18: u32 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G15_MASK: u32 = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

fn bch_type_info(data: u32) -> u32 {
    let mut d = data << 10;
    while bch_digit(d) - bch_digit(G15) >= 0 {
        d ^= G15 << (bch_digit(d) - bch_digit(G15));
    }
    ((data << 10) | d) ^ G15_MASK
}

fn bch_type_number(data: u32) -> u32 {
    let mut d = data << 12;
    while bch_digit(d) - bch_digit(G18) >= 0 {
        d ^= G18 << (bch_digit(d) - bch_digit(G18));
    }
    (data << 12) | d
}

#[derive(Default)]
struct BitBuffer {
    buf: Vec<u32>,
    len: usize,
}

impl BitBuffer {
    fn put(&mut self, num: u32, length: usize) {
        for i in 0..length {
            self.put_bit(((num >> (length - i - 1)) & 1) == 1);
        }
    }
    fn put_bit(&mut self, bit: bool) {
        let i = self.len / 8;
        if self.buf.len() <= i {
            self.buf.push(0);
        }
        if bit {
            self.buf[i] |= 0x80 >> (self.len % 8);
        }
        self.len += 1;
    }
}

fn length_bits(type_number: usize) -> usize {
    if type_number < 10 { 8 } else { 16 }
}

fn put_data(buf: &mut BitBuffer, bytes: &[u32], type_number: usize) {
    buf.put(MODE_8BIT, 4);
    buf.put(bytes.len() as u32, length_bits(type_number));
    for b in bytes {
        buf.put(*b, 8);
    }
}

/// (totalCount, dataCount) of each block at the level.
fn rs_blocks(type_number: usize, level: Level) -> Vec<(usize, usize)> {
    let row = level.table[type_number - 1];
    let mut out = Vec::new();
    for k in 0..row.len() / 3 {
        for _ in 0..row[k * 3] {
            out.push((row[k * 3 + 1], row[k * 3 + 2]));
        }
    }
    out
}

fn create_data(type_number: usize, bytes: &[u32], level: Level) -> Vec<u32> {
    let blocks = rs_blocks(type_number, level);
    let mut buf = BitBuffer::default();
    put_data(&mut buf, bytes, type_number);
    let total: usize = blocks.iter().map(|b| b.1).sum();
    if buf.len + 4 <= total * 8 {
        buf.put(0, 4);
    }
    while buf.len % 8 != 0 {
        buf.put_bit(false);
    }
    loop {
        if buf.len >= total * 8 {
            break;
        }
        buf.put(PAD0, 8);
        if buf.len >= total * 8 {
            break;
        }
        buf.put(PAD1, 8);
    }
    create_bytes(&buf, &blocks)
}

fn create_bytes(buf: &BitBuffer, blocks: &[(usize, usize)]) -> Vec<u32> {
    let mut offset = 0;
    let (mut max_dc, mut max_ec) = (0, 0);
    let mut dcdata = Vec::new();
    let mut ecdata = Vec::new();
    for &(total, dc) in blocks {
        let ec = total - dc;
        max_dc = max_dc.max(dc);
        max_ec = max_ec.max(ec);
        let d: Vec<u32> = (0..dc).map(|i| 0xff & buf.buf.get(i + offset).copied().unwrap_or(0)).collect();
        offset += dc;
        let rs = ec_polynomial(ec);
        let raw = Poly::new(&d, rs.len() - 1);
        let m = raw.modulo(&rs);
        let e: Vec<u32> = (0..rs.len() - 1)
            .map(|i| {
                let idx = i as i64 + m.len() as i64 - (rs.len() - 1) as i64;
                if idx >= 0 { m.0[idx as usize] } else { 0 }
            })
            .collect();
        dcdata.push(d);
        ecdata.push(e);
    }
    let mut out = Vec::new();
    for i in 0..max_dc {
        for d in &dcdata {
            if i < d.len() {
                out.push(d[i]);
            }
        }
    }
    for i in 0..max_ec {
        for e in &ecdata {
            if i < e.len() {
                out.push(e[i]);
            }
        }
    }
    out
}

/// A polynomial over GF(256) as the package keeps it: leading zeros dropped, `shift` zeros added at the end (the
/// package leaves them `undefined`, which acts as 0 in every operation it does on them).
struct Poly(Vec<u32>);

impl Poly {
    fn new(num: &[u32], shift: usize) -> Poly {
        let offset = num.iter().take_while(|x| **x == 0).count();
        let mut v: Vec<u32> = num[offset..].to_vec();
        v.extend(std::iter::repeat_n(0, shift));
        Poly(v)
    }
    fn len(&self) -> usize {
        self.0.len()
    }
    fn multiply(&self, e: &Poly) -> Poly {
        let mut num = vec![0u32; self.len() + e.len() - 1];
        for i in 0..self.len() {
            for j in 0..e.len() {
                num[i + j] ^= gexp(glog(self.0[i]) + glog(e.0[j]));
            }
        }
        Poly::new(&num, 0)
    }
    fn modulo(&self, e: &Poly) -> Poly {
        let mut cur = Poly(self.0.clone());
        loop {
            if (cur.len() as i64) - (e.len() as i64) < 0 {
                return cur;
            }
            let ratio = glog(cur.0[0]) - glog(e.0[0]);
            let mut num = cur.0.clone();
            for i in 0..e.len() {
                num[i] ^= gexp(glog(e.0[i]) + ratio);
            }
            cur = Poly::new(&num, 0);
        }
    }
}

fn ec_polynomial(len: usize) -> Poly {
    let mut a = Poly::new(&[1], 0);
    for i in 0..len {
        a = a.multiply(&Poly::new(&[1, gexp(i as i64)], 0));
    }
    a
}

struct Tables {
    exp: [u32; 256],
    log: [i64; 256],
}

static TABLES: std::sync::LazyLock<Tables> = std::sync::LazyLock::new(|| {
    let mut exp = [0u32; 256];
    let mut log = [0i64; 256];
    for (i, e) in exp.iter_mut().enumerate().take(8) {
        *e = 1 << i;
    }
    for i in 8..256 {
        exp[i] = exp[i - 4] ^ exp[i - 5] ^ exp[i - 6] ^ exp[i - 8];
    }
    for i in 0..255 {
        log[exp[i] as usize] = i as i64;
    }
    Tables { exp, log }
});

fn glog(n: u32) -> i64 {
    // The package throws for 0; a polynomial here never has a 0 where it takes the log (leading zeros are dropped and
    // the generator has none).
    TABLES.log[n as usize]
}

fn gexp(mut n: i64) -> u32 {
    while n < 0 {
        n += 255;
    }
    while n >= 256 {
        n -= 255;
    }
    TABLES.exp[n as usize]
}

static PATTERN_POSITION: [&[usize]; 40] = [
    &[],
    &[6, 18],
    &[6, 22],
    &[6, 26],
    &[6, 30],
    &[6, 34],
    &[6, 22, 38],
    &[6, 24, 42],
    &[6, 26, 46],
    &[6, 28, 50],
    &[6, 30, 54],
    &[6, 32, 58],
    &[6, 34, 62],
    &[6, 26, 46, 66],
    &[6, 26, 48, 70],
    &[6, 26, 50, 74],
    &[6, 30, 54, 78],
    &[6, 30, 56, 82],
    &[6, 30, 58, 86],
    &[6, 34, 62, 90],
    &[6, 28, 50, 72, 94],
    &[6, 26, 50, 74, 98],
    &[6, 30, 54, 78, 102],
    &[6, 28, 54, 80, 106],
    &[6, 32, 58, 84, 110],
    &[6, 30, 58, 86, 114],
    &[6, 34, 62, 90, 118],
    &[6, 26, 50, 74, 98, 122],
    &[6, 30, 54, 78, 102, 126],
    &[6, 26, 52, 78, 104, 130],
    &[6, 30, 56, 82, 108, 134],
    &[6, 34, 60, 86, 112, 138],
    &[6, 30, 58, 86, 114, 142],
    &[6, 34, 62, 90, 118, 146],
    &[6, 30, 54, 78, 102, 126, 150],
    &[6, 24, 50, 76, 102, 128, 154],
    &[6, 28, 54, 80, 106, 132, 158],
    &[6, 32, 58, 84, 110, 136, 162],
    &[6, 26, 54, 82, 110, 138, 166],
    &[6, 30, 58, 86, 114, 142, 170],
];

/// The package's RS block table, level M rows only: (count, totalCount, dataCount) groups per type number.
static RS_BLOCK_M: [&[usize]; 40] = [
    &[1, 26, 16],
    &[1, 44, 28],
    &[1, 70, 44],
    &[2, 50, 32],
    &[2, 67, 43],
    &[4, 43, 27],
    &[4, 49, 31],
    &[2, 60, 38, 2, 61, 39],
    &[3, 58, 36, 2, 59, 37],
    &[4, 69, 43, 1, 70, 44],
    &[1, 80, 50, 4, 81, 51],
    &[6, 58, 36, 2, 59, 37],
    &[8, 59, 37, 1, 60, 38],
    &[4, 64, 40, 5, 65, 41],
    &[5, 65, 41, 5, 66, 42],
    &[7, 73, 45, 3, 74, 46],
    &[10, 74, 46, 1, 75, 47],
    &[9, 69, 43, 4, 70, 44],
    &[3, 70, 44, 11, 71, 45],
    &[3, 67, 41, 13, 68, 42],
    &[17, 68, 42],
    &[17, 74, 46],
    &[4, 75, 47, 14, 76, 48],
    &[6, 73, 45, 14, 74, 46],
    &[8, 75, 47, 13, 76, 48],
    &[19, 74, 46, 4, 75, 47],
    &[22, 73, 45, 3, 74, 46],
    &[3, 73, 45, 23, 74, 46],
    &[21, 73, 45, 7, 74, 46],
    &[19, 75, 47, 10, 76, 48],
    &[2, 74, 46, 29, 75, 47],
    &[10, 74, 46, 23, 75, 47],
    &[14, 74, 46, 21, 75, 47],
    &[14, 74, 46, 23, 75, 47],
    &[12, 75, 47, 26, 76, 48],
    &[6, 75, 47, 34, 76, 48],
    &[29, 74, 46, 14, 75, 47],
    &[13, 74, 46, 32, 75, 47],
    &[40, 75, 47, 7, 76, 48],
    &[18, 75, 47, 31, 76, 48],
];

/// The package's RS block table, level L rows.
static RS_BLOCK_L: [&[usize]; 40] = [
    &[1, 26, 19],
    &[1, 44, 34],
    &[1, 70, 55],
    &[1, 100, 80],
    &[1, 134, 108],
    &[2, 86, 68],
    &[2, 98, 78],
    &[2, 121, 97],
    &[2, 146, 116],
    &[2, 86, 68, 2, 87, 69],
    &[4, 101, 81],
    &[2, 116, 92, 2, 117, 93],
    &[4, 133, 107],
    &[3, 145, 115, 1, 146, 116],
    &[5, 109, 87, 1, 110, 88],
    &[5, 122, 98, 1, 123, 99],
    &[1, 135, 107, 5, 136, 108],
    &[5, 150, 120, 1, 151, 121],
    &[3, 141, 113, 4, 142, 114],
    &[3, 135, 107, 5, 136, 108],
    &[4, 144, 116, 4, 145, 117],
    &[2, 139, 111, 7, 140, 112],
    &[4, 151, 121, 5, 152, 122],
    &[6, 147, 117, 4, 148, 118],
    &[8, 132, 106, 4, 133, 107],
    &[10, 142, 114, 2, 143, 115],
    &[8, 152, 122, 4, 153, 123],
    &[3, 147, 117, 10, 148, 118],
    &[7, 146, 116, 7, 147, 117],
    &[5, 145, 115, 10, 146, 116],
    &[13, 145, 115, 3, 146, 116],
    &[17, 145, 115],
    &[17, 145, 115, 1, 146, 116],
    &[13, 145, 115, 6, 146, 116],
    &[12, 151, 121, 7, 152, 122],
    &[6, 151, 121, 14, 152, 122],
    &[17, 152, 122, 4, 153, 123],
    &[4, 152, 122, 18, 153, 123],
    &[20, 147, 117, 4, 148, 118],
    &[19, 148, 118, 6, 149, 119],
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Made by Bun with `qrSvg` (qrcode-generator 1.5.2): `cases.json` holds `[text, svg]` pairs.
    #[test]
    fn same_svg_as_bun() {
        let cases: Vec<(String, String)> = serde_json::from_str(include_str!("qr-cases.json")).unwrap();
        assert!(cases.len() >= 6);
        for (text, svg) in cases {
            assert_eq!(qr_svg(&text), svg, "{text}");
        }
    }

    /// Made by Bun with `qrTerminal`: `[text, lines]` pairs.
    #[test]
    fn same_terminal_qr_as_bun() {
        let cases: Vec<(String, String)> = serde_json::from_str(include_str!("qr-terminal-cases.json")).unwrap();
        for (text, want) in cases {
            assert_eq!(qr_terminal(&text), want, "{text}");
        }
    }
}
