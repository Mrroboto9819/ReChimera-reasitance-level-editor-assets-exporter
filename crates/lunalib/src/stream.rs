use std::io::{Read, Seek, SeekFrom};

use byteorder::{BigEndian, LittleEndian, ReadBytesExt};

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endian {
    Big,
    Little,
}

/// Endian-aware reader. PS3 IGHW files start big-endian; the magic word
/// determines whether the rest of the file should be interpreted little-endian.
pub struct StreamHelper<R: Read + Seek> {
    inner: R,
    pub endian: Endian,
}

impl<R: Read + Seek> StreamHelper<R> {
    pub fn new(inner: R, endian: Endian) -> Self {
        Self { inner, endian }
    }

    pub fn into_inner(self) -> R {
        self.inner
    }

    pub fn get_mut(&mut self) -> &mut R {
        &mut self.inner
    }

    pub fn seek_to(&mut self, offset: u64) -> Result<u64> {
        Ok(self.inner.seek(SeekFrom::Start(offset))?)
    }

    pub fn position(&mut self) -> Result<u64> {
        Ok(self.inner.stream_position()?)
    }

    pub fn read_u8(&mut self) -> Result<u8> {
        Ok(self.inner.read_u8()?)
    }

    pub fn read_i8(&mut self) -> Result<i8> {
        Ok(self.inner.read_i8()?)
    }

    pub fn read_u16(&mut self) -> Result<u16> {
        Ok(match self.endian {
            Endian::Big => self.inner.read_u16::<BigEndian>()?,
            Endian::Little => self.inner.read_u16::<LittleEndian>()?,
        })
    }

    pub fn read_u32(&mut self) -> Result<u32> {
        Ok(match self.endian {
            Endian::Big => self.inner.read_u32::<BigEndian>()?,
            Endian::Little => self.inner.read_u32::<LittleEndian>()?,
        })
    }

    pub fn read_u64(&mut self) -> Result<u64> {
        Ok(match self.endian {
            Endian::Big => self.inner.read_u64::<BigEndian>()?,
            Endian::Little => self.inner.read_u64::<LittleEndian>()?,
        })
    }

    pub fn read_i16(&mut self) -> Result<i16> {
        Ok(match self.endian {
            Endian::Big => self.inner.read_i16::<BigEndian>()?,
            Endian::Little => self.inner.read_i16::<LittleEndian>()?,
        })
    }

    pub fn read_i32(&mut self) -> Result<i32> {
        Ok(match self.endian {
            Endian::Big => self.inner.read_i32::<BigEndian>()?,
            Endian::Little => self.inner.read_i32::<LittleEndian>()?,
        })
    }

    pub fn read_f32(&mut self) -> Result<f32> {
        Ok(match self.endian {
            Endian::Big => self.inner.read_f32::<BigEndian>()?,
            Endian::Little => self.inner.read_f32::<LittleEndian>()?,
        })
    }

    /// Read three consecutive `f32`s as `[x, y, z]`.
    pub fn read_vec3(&mut self) -> Result<[f32; 3]> {
        Ok([self.read_f32()?, self.read_f32()?, self.read_f32()?])
    }

    pub fn read_bytes(&mut self, n: usize) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; n];
        self.inner.read_exact(&mut buf)?;
        Ok(buf)
    }

    /// Read a NUL-terminated ASCII string at the current position.
    pub fn read_cstring(&mut self) -> Result<String> {
        let mut bytes = Vec::new();
        loop {
            let b = self.read_u8()?;
            if b == 0 {
                break;
            }
            bytes.push(b);
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Seek to `offset`, read a NUL-terminated string, then restore position.
    pub fn read_cstring_at(&mut self, offset: u64) -> Result<String> {
        let saved = self.position()?;
        self.seek_to(offset)?;
        let s = self.read_cstring()?;
        self.seek_to(saved)?;
        Ok(s)
    }
}
