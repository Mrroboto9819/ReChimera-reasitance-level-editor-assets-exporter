

pub mod error;
pub mod reader;

pub use error::{Error, Result};
pub use reader::{Archive, Compression, Entry, Header};
